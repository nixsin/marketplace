import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation identifiers carried alongside every request.
 *
 * Three separate fields, deliberately NOT one composite string. The
 * relationship really is hierarchical -- a session contains page views,
 * a page view triggers requests -- but encoding that as
 * `session:page:request` would mean prefix-matching a long opaque blob at
 * query time instead of filtering an indexed field, and would bake
 * client-controlled data into the one identifier the server vouches for.
 * Keeping them separate also means OpenTelemetry can slot in later:
 * `trace_id`/`span_id` are fields it generates itself, and `sessionId`
 * becomes an attribute beside them rather than something to unpick.
 */
export interface Correlation {
  /**
   * Server-generated, one per HTTP request. The only field here the
   * server vouches for -- everything else arrived from a browser.
   */
  requestId: string;
  /** Browser-supplied, spans a user session. Untrusted. */
  sessionId?: string;
  /** Browser-supplied, spans one navigation. Untrusted. */
  pageViewId?: string;
  /**
   * Browser-supplied, the id the client assigned to this call before
   * sending it.
   *
   * Worth its own field rather than being folded into requestId: when a
   * request never completes -- timeout, dropped connection, API down --
   * there is no response, so the browser never learns the server's id.
   * That is precisely the failure worth debugging, and this is what lets
   * a client-side error log be matched against a server log afterwards
   * (or to establish that the request never arrived at all).
   */
  clientRequestId?: string;
}

export const CORRELATION_HEADERS = {
  requestId: 'x-request-id',
  sessionId: 'x-session-id',
  pageViewId: 'x-page-view-id',
  clientRequestId: 'x-client-request-id',
} as const;

/**
 * Bounds on a client-supplied identifier.
 *
 * These values are written straight into logs, so they are an injection
 * surface, not just a formatting concern: a value containing a newline can
 * forge whole log entries, and an unbounded one can bloat every line it
 * appears on. Restricting to an id-shaped charset removes both, and costs
 * nothing -- every id we issue is a UUID.
 */
const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Returns the value if it is a plausible identifier, otherwise undefined.
 *
 * Drops rather than throws, on purpose: a malformed correlation id is a
 * telemetry problem, and telemetry must never be able to fail a request
 * that would otherwise have succeeded.
 */
export function sanitizeClientId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** A fresh server-side request id. */
export function newRequestId(): string {
  return randomUUID();
}

const storage = new AsyncLocalStorage<Correlation>();

/**
 * Runs `fn` with `correlation` available to everything it awaits.
 *
 * AsyncLocalStorage rather than passing a parameter through every layer:
 * a resolver three calls deep should not need a plumbing argument just so
 * a log line can be attributed, and threading one through would mean
 * touching every signature in the app.
 */
export function runWithCorrelation<T>(
  correlation: Correlation,
  fn: () => T,
): T {
  return storage.run(correlation, fn);
}

/**
 * The current request's correlation, or undefined outside a request --
 * a scheduled job, a startup task, a unit test. Callers must handle
 * undefined rather than assume a request is in progress.
 */
export function getCorrelation(): Correlation | undefined {
  return storage.getStore();
}

/** Correlation fields as flat log attributes, omitting absent ones. */
export function correlationFields(
  correlation = getCorrelation(),
): Record<string, string> {
  if (!correlation) return {};
  const { requestId, sessionId, pageViewId, clientRequestId } = correlation;
  return {
    request_id: requestId,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(pageViewId ? { page_view_id: pageViewId } : {}),
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
  };
}
