import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_HEADERS } from './observability/correlation';
import {
  graphqlCacheControl,
  isCacheableGraphqlResponse,
} from './graphql-cache';
import { correlationMiddleware } from './observability/correlation.middleware';
import { CorrelationExceptionFilter } from './observability/correlation-exception.filter';

// Shared between main.ts (real bootstrap) and e2e tests (which build their
// own app instance directly via Test.createTestingModule, bypassing
// bootstrap() entirely) — so behavior under test actually matches what
// runs in production, instead of two copies drifting apart.
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Before anything else, so every later handler and log line can attribute
  // itself to a request.
  app.use(correlationMiddleware);

  // Logs every unhandled error with the ids of the request that caused it.
  // Without this the ids are collected and never used, which leaves the
  // browser-error-to-server-log workflow undelivered.
  app.useGlobalFilters(new CorrelationExceptionFilter());

  app.enableCors({
    // allowedHeaders must be explicit once we ask the browser to send
    // correlation headers: naming any header at all replaces the default
    // reflect-whatever-was-requested behaviour, so apollo-require-preflight
    // (Apollo's CSRF check, sent on every GET from apps/web) has to be
    // listed here too or every request starts failing preflight.
    allowedHeaders: [
      'content-type',
      // Non-negotiable, and the one this list originally missed. Naming
      // any header here replaces the default reflect-whatever-was-asked
      // behaviour, so every header the browser may send has to be listed
      // -- and omitting authorization silently breaks every authenticated
      // request. Caught by the sw-cache-isolation e2e suite, whose
      // synthetic Authorization-bearing request started failing preflight;
      // nothing else in the app sends one yet, so no unit test could have.
      'authorization',
      'apollo-require-preflight',
      CORRELATION_HEADERS.sessionId,
      CORRELATION_HEADERS.pageViewId,
      CORRELATION_HEADERS.clientRequestId,
    ],
    // Without this the response header is sent but invisible to JavaScript:
    // browsers hide all but a handful of headers on cross-origin responses
    // unless they are named here. The failure is silent -- headers.get()
    // simply returns null -- so it is worth stating why this line exists.
    exposedHeaders: [CORRELATION_HEADERS.requestId],
    // The real fix for an existing latency bug, not just setup for the
    // above. apps/web already sends a custom header (apollo-require-
    // preflight), which makes every API call a preflighted cross-origin
    // request -- and with no max-age the browser re-runs that preflight
    // before EVERY request, paying a full extra round trip each time. On
    // the high-latency connections this app targets that is the single
    // cheapest latency win available. 86400s is the practical ceiling
    // (Chrome caps at 2h, Firefox at 24h; both clamp rather than reject).
    maxAge: 86_400,
  });

  // Apollo Server sets `Cache-Control: no-store` by default on every
  // response -- a safe default, since it can't know an arbitrary query's
  // result is cacheable without explicit per-field hints. GET requests to
  // /graphql are only ever used here for read-only queries (see
  // products.resolver.ts / fetchProductsPaged); POST stays uncacheable
  // for everything else (mutations, and any query sent that way).
  //
  // WHY res.send AND NOT res.setHeader, which this used to hook. Read
  // straight off Apollo's express integration (dist/cjs/index.js), which
  // does exactly this, in this order:
  //
  //     res.setHeader(key, value);          // <- headers first
  //     res.statusCode = response.status;   // <- status AFTER them
  //     res.send(response.body.string);
  //
  // So at setHeader time the status is still the default 200 and no body
  // exists yet. The old wrapper therefore had to decide blind, and
  // decided "cacheable" every time -- including for GraphQL's resolver
  // errors, which are reported as HTTP 200 with an `errors` array.
  // Harmless while nothing cached these responses; an outage amplifier
  // the moment a CDN does. See isCacheableGraphqlResponse.
  //
  // res.send is the first point where the status and the complete body
  // are both final, and it runs BEFORE Express's own conditional-GET
  // transform -- which matters: Express turns a fresh request into a 304
  // by blanking the body and stripping the Content-* headers, but it
  // leaves Cache-Control alone. Setting it here means a revalidation
  // still carries the caching policy of the response it revalidates,
  // rather than the empty 304 losing it. Deciding here also keeps the
  // outcome independent of Apollo's internal plugin ordering.
  app.use('/graphql', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') {
      next();
      return;
    }

    // Unconditional, unlike the caching header: this opts a cross-origin
    // response into exposing real timing/transfer-size data to the
    // Resource Timing API, which browsers otherwise zero out for privacy.
    // Without it, actual cache hits are impossible to verify or monitor
    // from frontend code (e.g. via RUM) rather than by a manual curl --
    // just as worth measuring on a failing request as a succeeding one,
    // hence every GET rather than only the cacheable ones.
    res.setHeader('Timing-Allow-Origin', '*');

    // Express's send() is an overloaded signature TypeScript cannot carry
    // through a wrapper cleanly -- the same inference limitation the
    // previous setHeader wrapper documented, handled the same way.
    const originalSend = res.send.bind(res) as (body?: unknown) => Response;
    res.send = function patchedSend(body?: unknown): Response {
      // headersSent covers Apollo's chunked branch (res.write/res.end for
      // incremental delivery, unused by any query here): once anything is
      // flushed, setHeader throws and a partial body could not be judged
      // correctly anyway. Fail closed.
      if (
        !res.headersSent &&
        isCacheableGraphqlResponse(res.statusCode, body)
      ) {
        // s-maxage + stale-while-revalidate, not a bare max-age=0 -- see
        // graphql-cache.ts for which directive serves which cache.
        res.setHeader('Cache-Control', graphqlCacheControl());
      }
      return originalSend(body);
    } as typeof res.send;

    next();
  });
}
