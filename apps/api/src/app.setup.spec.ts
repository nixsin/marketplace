// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { configureApp } from './app.setup';
import { CORRELATION_HEADERS } from './observability/correlation';
import { correlationMiddleware } from './observability/correlation.middleware';
import { CorrelationExceptionFilter } from './observability/correlation-exception.filter';

/**
 * The shared bootstrap, which had no unit test.
 *
 * Its two most consequential decisions are invisible from the outside
 * until they are wrong in production: the CORS allowlist (where omitting
 * one header silently breaks every request that sends it) and the
 * /graphql cache-control patch (where getting the timing wrong makes
 * GraphQL errors publicly cacheable). Both are covered by e2e tests over
 * real HTTP, but coverage is only collected from this suite, so neither
 * was measured -- and the CORS list in particular has already lost a
 * header once, caught only by an unrelated e2e suite.
 */
describe('configureApp', () => {
  let app: {
    useGlobalPipes: jest.Mock;
    useGlobalFilters: jest.Mock;
    use: jest.Mock;
    enableCors: jest.Mock;
  };

  /** The handler registered for '/graphql', with its middleware signature. */
  function graphqlMiddleware() {
    const call = app.use.mock.calls.find((c) => c[0] === '/graphql');
    // Jest's expect takes no message argument (that is Vitest); throw
    // instead so a missing registration fails with something readable.
    if (!call) throw new Error("no '/graphql' middleware was registered");
    return call![1] as (
      req: Partial<Request>,
      res: Partial<Response>,
      next: NextFunction,
    ) => void;
  }

  /** A response double that records headers and captures the patched send. */
  function makeRes(statusCode = 200) {
    const headers: Record<string, unknown> = {};
    const res = {
      statusCode,
      headersSent: false,
      // Returns the response, as Express's setHeader does. A void return
      // makes the double structurally unassignable to Partial<Response> --
      // a real TS2345 that nothing currently reports, because nest build
      // excludes specs and ts-jest transpiles without type-checking.
      setHeader: (k: string, v: unknown) => {
        headers[k] = v;
        return res as unknown as Response;
      },
      // Typed with a body parameter to match Express's Response.send(body?).
      // A zero-arg implementation makes Jest infer a zero-arg mock, so every
      // `res.send('...')` below would be passing an argument the type says
      // does not exist.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      send: jest.fn((_body?: unknown) => res as unknown as Response),
    };
    // The middleware REPLACES res.send, so the original mock has to be
    // held separately -- asserting on res.send after patching would be
    // asserting on the wrapper, not on what actually answered.
    return { res, headers, originalSend: res.send };
  }

  beforeEach(() => {
    app = {
      useGlobalPipes: jest.fn(),
      useGlobalFilters: jest.fn(),
      use: jest.fn(),
      enableCors: jest.fn(),
    };
    configureApp(app as unknown as INestApplication);
  });

  it('installs a ValidationPipe, the correlation filter, and middleware', () => {
    // Asserting the INSTANCES, not just the call counts. Counting alone
    // passes if configureApp installs the wrong pipe, the wrong filter, or
    // arbitrary middleware -- which is everything the description claims.
    const pipe = app.useGlobalPipes.mock.calls[0][0];
    const filter = app.useGlobalFilters.mock.calls[0][0];

    expect(pipe).toBeInstanceOf(ValidationPipe);
    expect(filter).toBeInstanceOf(CorrelationExceptionFilter);
    // Correlation middleware first, so every later handler and log line can
    // attribute itself to a request.
    expect(app.use.mock.calls[0][0]).toBe(correlationMiddleware);
  });

  describe('CORS', () => {
    it('names every header the browser is allowed to send', () => {
      // Naming ANY header replaces the default reflect-what-was-asked
      // behaviour, so an omission here breaks requests silently rather
      // than loudly. `authorization` was missing once already and was
      // caught only by an unrelated e2e suite.
      const cors = app.enableCors.mock.calls[0][0] as {
        allowedHeaders: string[];
        exposedHeaders: string[];
        maxAge: number;
      };

      expect(cors.allowedHeaders).toEqual(
        expect.arrayContaining([
          'content-type',
          'authorization',
          'apollo-require-preflight',
          CORRELATION_HEADERS.sessionId,
          CORRELATION_HEADERS.pageViewId,
          CORRELATION_HEADERS.clientRequestId,
        ]),
      );
    });

    it('exposes the request id so the browser can actually read it', () => {
      // Browsers hide all but a handful of headers cross-origin unless
      // named here, and the failure is silent -- headers.get() just
      // returns null.
      const cors = app.enableCors.mock.calls[0][0] as {
        exposedHeaders: string[];
      };

      expect(cors.exposedHeaders).toContain(CORRELATION_HEADERS.requestId);
    });

    it('caches the preflight, which is a real latency fix', () => {
      // apps/web sends a custom header, so every call is preflighted. With
      // no max-age the browser re-runs that preflight before EVERY request
      // -- a full extra round trip each time, on connections where that
      // hurts most.
      const cors = app.enableCors.mock.calls[0][0] as { maxAge: number };

      expect(cors.maxAge).toBe(86_400);
    });
  });

  describe('/graphql cache-control', () => {
    it('leaves non-GET requests entirely alone', () => {
      const { res, headers, originalSend } = makeRes();
      const next = jest.fn();

      graphqlMiddleware()({ method: 'POST' }, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect(res.send).toBe(originalSend); // not patched
      expect(headers['Timing-Allow-Origin']).toBeUndefined();
    });

    it('sets Timing-Allow-Origin on EVERY GET, cacheable or not', () => {
      // Deliberately unconditional: a failing request is exactly the one
      // worth measuring from RUM, and browsers zero cross-origin timing
      // data without this.
      const { res, headers } = makeRes();

      graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
      res.send('{"errors":[{"message":"nope"}]}');

      expect(headers['Timing-Allow-Origin']).toBe('*');
      expect(headers['Cache-Control']).toBeUndefined();
    });

    it('marks a successful body cacheable', () => {
      const { res, headers } = makeRes();

      graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
      res.send('{"data":{"products":[]}}');

      expect(String(headers['Cache-Control'])).toContain('s-maxage');
    });

    it('does NOT cache a 200 carrying an errors array', () => {
      // GraphQL reports resolver failures as HTTP 200. Caching one behind
      // a CDN turns a one-second blip into a stored outage for everyone
      // routed through that edge, with no purge hook to cut it short.
      const { res, headers } = makeRes();

      graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
      res.send('{"errors":[{"message":"boom"}],"data":null}');

      expect(headers['Cache-Control']).toBeUndefined();
    });

    it.each([400, 404, 429, 500, 502, 503])(
      'does NOT cache a %i, even with a success-shaped body',
      (status) => {
        // The status line is checked as well as the body. Without this, an
        // implementation that keyed only on `data` being present would mark
        // a 500 publicly cacheable -- storing an outage at the edge for
        // s-maxage plus the whole stale-while-revalidate window on top, for
        // everyone routed through that location, with no purge hook.
        const { res, headers } = makeRes(status);

        graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
        res.send('{"data":{"products":[]}}');

        expect(headers['Cache-Control']).toBeUndefined();
        // Still measurable from RUM, which is the point of setting this
        // unconditionally -- a failing request is worth timing too.
        expect(headers['Timing-Allow-Origin']).toBe('*');
      },
    );

    it('does not cache a 304, whose body Express has already blanked', () => {
      // Express builds a 304 by emptying the body and stripping Content-*,
      // leaving Cache-Control alone. An empty body cannot be judged, so
      // this must fail closed rather than guess.
      const { res, headers } = makeRes(304);

      graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
      res.send('');

      expect(headers['Cache-Control']).toBeUndefined();
    });

    it('FAILS CLOSED once headers are already sent', () => {
      // Apollo's chunked branch flushes before send; setHeader would throw,
      // and a partial body could not be judged correctly anyway. Not
      // caching something cacheable costs a round trip; caching an error
      // costs an outage.
      const { res, headers } = makeRes();
      graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
      res.headersSent = true;

      res.send('{"data":{"products":[]}}');

      expect(headers['Cache-Control']).toBeUndefined();
    });

    it('still delivers the body through the patched send', () => {
      // The wrapper must remain transparent -- the original send is what
      // actually answers the request.
      const { res, originalSend } = makeRes();

      graphqlMiddleware()({ method: 'GET' }, res, jest.fn() as NextFunction);
      res.send('{"data":{}}');

      expect(originalSend).toHaveBeenCalledWith('{"data":{}}');
    });
  });
});
