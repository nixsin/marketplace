import { GRAPHQL_ERROR_CODES } from '@medinstru/config';
import type { GraphQLFormattedError } from 'graphql';

/**
 * HTTP status -> the standard GraphQL error code for it.
 *
 * Nest's exceptions already carry the correct HTTP semantics, so the status is
 * the discriminator and nothing new has to be invented: a service throws
 * `ConflictException` because the situation IS a conflict, and this turns that
 * into the code the ecosystem already uses for it.
 *
 * That is the whole design. The alternative -- a parallel registry of
 * app-specific codes -- would mean every throw site naming its category twice,
 * in two vocabularies that can disagree.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: GRAPHQL_ERROR_CODES.badUserInput,
  401: GRAPHQL_ERROR_CODES.unauthenticated,
  403: GRAPHQL_ERROR_CODES.forbidden,
  404: GRAPHQL_ERROR_CODES.notFound,
  409: GRAPHQL_ERROR_CODES.conflict,
  429: GRAPHQL_ERROR_CODES.tooManyRequests,
};

/**
 * Gives every error a code a client can branch on, and stops leaking internals.
 *
 * TWO THINGS, because the same wrapper is the only place to do either.
 *
 * 1. THE CODE. Nest reports every HTTP exception through GraphQL as the
 *    generic `BAD_REQUEST` -- verified on the wire, where a rate-limit
 *    rejection and an idempotency conflict were byte-identical apart from
 *    their prose. That left apps/web reading the message text to decide what
 *    to tell the buyer, which made the wording a load-bearing API and broke
 *    once already.
 *
 * 2. THE LEAK. Nest also attaches `extensions.originalError`, carrying its own
 *    `statusCode` and `error` fields, to every anonymous caller. That is
 *    framework detail nobody outside needs, and this API's own discipline
 *    elsewhere is that a buyer-facing response carries only what it must. It
 *    is dropped once the status has been read off it.
 *
 * Anything without a Nest status keeps whatever code Apollo assigned --
 * GRAPHQL_VALIDATION_FAILED, INTERNAL_SERVER_ERROR and friends are already
 * the standard names, so overwriting them would be the opposite of the goal.
 */
export function formatGraphqlError(
  formatted: GraphQLFormattedError,
): GraphQLFormattedError {
  const extensions = formatted.extensions;
  if (!extensions || typeof extensions !== 'object') return formatted;

  const original = (extensions as { originalError?: unknown }).originalError;
  const status =
    original && typeof original === 'object'
      ? (original as { statusCode?: unknown }).statusCode
      : undefined;

  // Everything except originalError is preserved. `code` is replaced only when
  // a status actually maps -- an unrecognised status leaves Apollo's own code
  // rather than inventing one, so a new exception type degrades to the generic
  // answer instead of a wrong one.
  const rest = { ...(extensions as Record<string, unknown>) };
  delete rest.originalError;

  const code = typeof status === 'number' ? CODE_BY_STATUS[status] : undefined;

  return {
    ...formatted,
    extensions: code ? { ...rest, code } : rest,
  };
}
