import { GRAPHQL_ERROR_CODES } from '@medinstru/config';
import type { GraphQLFormattedError } from 'graphql';
import { formatGraphqlError } from './graphql-error';

/** A formatted error shaped the way Nest hands one to Apollo. */
const fromNest = (statusCode: number): GraphQLFormattedError => ({
  message: 'nope',
  extensions: {
    code: 'BAD_REQUEST',
    originalError: { message: 'nope', error: 'Bad Request', statusCode },
  },
});

describe('formatGraphqlError', () => {
  it('maps each status to the standard code for it', () => {
    // The whole point: Nest reports every HTTP exception over GraphQL as the
    // generic BAD_REQUEST, so a rate limit and an idempotency conflict were
    // byte-identical apart from their prose -- which is why apps/web ended up
    // reading the message text to decide what to tell the buyer.
    const expected: Array<[number, string]> = [
      [400, GRAPHQL_ERROR_CODES.badUserInput],
      [401, GRAPHQL_ERROR_CODES.unauthenticated],
      [403, GRAPHQL_ERROR_CODES.forbidden],
      [404, GRAPHQL_ERROR_CODES.notFound],
      [409, GRAPHQL_ERROR_CODES.conflict],
      [429, GRAPHQL_ERROR_CODES.tooManyRequests],
    ];

    for (const [status, code] of expected) {
      expect(formatGraphqlError(fromNest(status)).extensions?.code).toBe(code);
    }
  });

  it('drops originalError, which leaks framework internals', () => {
    // statusCode and error are Nest's own vocabulary and were being handed to
    // every anonymous caller.
    const out = formatGraphqlError(fromNest(409));
    expect(out.extensions?.originalError).toBeUndefined();
  });

  it('keeps other extensions untouched', () => {
    const out = formatGraphqlError({
      message: 'nope',
      extensions: {
        code: 'BAD_REQUEST',
        originalError: { statusCode: 404 },
        traceId: 'abc',
      },
    });
    expect(out.extensions?.traceId).toBe('abc');
    expect(out.extensions?.code).toBe(GRAPHQL_ERROR_CODES.notFound);
  });

  it('leaves Apollo its own code when there is no Nest status', () => {
    // GRAPHQL_VALIDATION_FAILED and friends are already the standard names, so
    // overwriting them would be the opposite of what this function is for.
    const out = formatGraphqlError({
      message: 'bad query',
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    });
    expect(out.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('leaves an UNRECOGNISED status alone rather than inventing a code', () => {
    // A new exception type should degrade to the generic answer, never to a
    // confidently wrong one.
    const out = formatGraphqlError(fromNest(418));
    expect(out.extensions?.code).toBe('BAD_REQUEST');
    expect(out.extensions?.originalError).toBeUndefined();
  });

  it('passes through an error carrying no extensions at all', () => {
    const bare: GraphQLFormattedError = { message: 'nope' };
    expect(formatGraphqlError(bare)).toEqual(bare);
  });
});
