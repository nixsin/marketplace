import type { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_HEADERS,
  newRequestId,
  runWithCorrelation,
  sanitizeClientId,
  type Correlation,
} from './correlation';

/**
 * Establishes the correlation context for every request.
 *
 * The request id is ALWAYS generated here and never taken from the
 * request, even when the caller supplied one. An inbound value is
 * untrusted: a client could repeat one value across every request
 * (collapsing unrelated traffic into one apparent trace) or send a
 * crafted string that lands in logs. The caller's own id is preserved
 * separately as clientRequestId, which keeps it useful for matching
 * without letting it stand in for the server's own identifier.
 *
 * The exception worth knowing about: a genuine server-to-server hop --
 * apps/web server-rendering a product page and calling this API -- is a
 * case where forwarding the caller's id WOULD be correct, since both ends
 * are ours. That needs a trust signal (a shared secret header, or an
 * allowlisted internal network) before it can be told apart from a
 * browser claiming the same thing, so it is deliberately not done yet.
 */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlation: Correlation = {
    requestId: newRequestId(),
    sessionId: sanitizeClientId(req.headers[CORRELATION_HEADERS.sessionId]),
    pageViewId: sanitizeClientId(req.headers[CORRELATION_HEADERS.pageViewId]),
    clientRequestId: sanitizeClientId(
      req.headers[CORRELATION_HEADERS.clientRequestId],
    ),
  };

  // Echoed back so the browser can log the server's id against its own,
  // and so a user reporting a problem has one value to quote. Being a
  // cross-origin response, this header is invisible to JavaScript unless
  // it is also named in Access-Control-Expose-Headers -- see app.setup.ts.
  res.setHeader(CORRELATION_HEADERS.requestId, correlation.requestId);

  runWithCorrelation(correlation, () => next());
}
