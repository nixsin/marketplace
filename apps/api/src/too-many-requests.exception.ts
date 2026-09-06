import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429, which Nest has no built-in exception for.
 *
 * Rate-limit rejections were `BadRequestException` — a 400, meaning "you sent
 * something malformed", when the request was perfectly well-formed and simply
 * arrived too often. That mislabel is what left every rejection this API
 * produces sharing one generic code, so apps/web had to read the message text
 * to tell a rate limit from an idempotency conflict.
 *
 * Throwing the right status fixes it without any new vocabulary:
 * graphql-error.ts maps 429 to the standard TOO_MANY_REQUESTS.
 */
export class TooManyRequestsException extends HttpException {
  /**
   * @param retryAfterMs when the caller may try again, per RFC 9110's
   *   Retry-After semantics -- the server states it because only the server
   *   knows the window. Optional: a bucket with nothing to date the wait from
   *   yields no hint rather than a guessed one.
   */
  constructor(message: string, retryAfterMs?: number) {
    // createBody, NOT a bare string, and this is the whole reason the class
    // exists rather than an inline `new HttpException(msg, 429)`.
    //
    // Nest's built-in exceptions all produce `{ message, error, statusCode }`,
    // and @nestjs/graphql reads that shape to build the GraphQL error. A plain
    // string passes Nest's own filters happily and then surfaces over GraphQL
    // as INTERNAL_SERVER_ERROR -- a rate limit reported as a server fault,
    // which is both wrong and alarming.
    //
    // Caught on the wire, not in review: the first version did exactly that
    // and every unit test still passed.
    super(
      {
        ...HttpException.createBody(
          message,
          'Too Many Requests',
          HttpStatus.TOO_MANY_REQUESTS,
        ),
        // Travels in the body so it survives the conversion into a GraphQL
        // error, where formatGraphqlError lifts it onto extensions.
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
