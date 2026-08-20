import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_HEADERS } from './observability/correlation';
import { correlationMiddleware } from './observability/correlation.middleware';

// Shared between main.ts (real bootstrap) and e2e tests (which build their
// own app instance directly via Test.createTestingModule, bypassing
// bootstrap() entirely) — so behavior under test actually matches what
// runs in production, instead of two copies drifting apart.
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Before anything else, so every later handler and log line can attribute
  // itself to a request.
  app.use(correlationMiddleware);

  app.enableCors({
    // allowedHeaders must be explicit once we ask the browser to send
    // correlation headers: naming any header at all replaces the default
    // reflect-whatever-was-requested behaviour, so apollo-require-preflight
    // (Apollo's CSRF check, sent on every GET from apps/web) has to be
    // listed here too or every request starts failing preflight.
    allowedHeaders: [
      'content-type',
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
  // response — a safe default, since it can't know an arbitrary query's
  // result is cacheable without explicit per-field hints. GET requests to
  // /graphql are only ever used here for read-only, cacheable queries
  // (see products.resolver.ts / fetchProductsPaged) — POST stays
  // uncacheable for everything else (mutations, and any query sent that
  // way). Overriding per-request via a setHeader wrapper, since Apollo
  // sets its header after this middleware would otherwise run.
  // Express's Response.setHeader is an overloaded signature that
  // TypeScript can't carry through `.bind()` cleanly (a known inference
  // limitation, not a real type hole) — named and typed explicitly here
  // so the wrapper below doesn't end up implicitly `any`.
  type SetHeader = (
    name: string,
    value: number | string | readonly string[],
  ) => Response;

  app.use('/graphql', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') {
      const originalSetHeader = res.setHeader.bind(res) as SetHeader;
      res.setHeader = ((
        name: string,
        value: number | string | readonly string[],
      ) => {
        if (name.toLowerCase() === 'cache-control') {
          // Opts this cross-origin response into exposing real timing/
          // transfer-size data to the Resource Timing API — otherwise
          // browsers zero those values out for privacy on cross-origin
          // requests, which would make actual cache/304 hits impossible
          // to verify or monitor (e.g. via RUM) from frontend code, not
          // just from a manual curl check.
          originalSetHeader('Timing-Allow-Origin', '*');
          return originalSetHeader(
            'Cache-Control',
            'public, max-age=0, must-revalidate',
          );
        }
        return originalSetHeader(name, value);
      }) as typeof res.setHeader;
    }
    next();
  });
}
