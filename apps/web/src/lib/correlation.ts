import {
  CORRELATION_HEADERS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MINUTES,
} from "@medinstru/config";
/**
 * Browser-side correlation identifiers.
 *
 * Three distinct scopes, and it matters which is which:
 *
 *   session    one per user session (30 min idle)   many page views
 *   pageView   one per navigation                   many requests
 *   request    one per HTTP call                    generated per fetch
 *
 * The browser owns the first two, because only it knows when a session or
 * a navigation begins. The SERVER owns the request id -- see
 * apps/api/src/observability/correlation.ts for why a client-supplied one
 * is never trusted as the server's own.
 *
 * The client request id below is a fourth thing, and it exists for one
 * specific failure: when a call never completes -- timeout, dropped
 * connection, API down -- there is no response, so the browser never
 * learns the server's id. That is exactly the case worth debugging. Having
 * generated our own beforehand means a client-side error can still be
 * matched to a server log afterwards, or that the ABSENCE of a matching
 * server log tells us the request never arrived.
 */

const SESSION_COOKIE = SESSION_COOKIE_NAME;


export { CORRELATION_HEADERS };

/**
 * A random, opaque identifier.
 *
 * crypto.randomUUID() is available in every browser this app supports and
 * in Node, so no dependency. The fallback covers insecure contexts, where
 * it is undefined -- plain http on a LAN address during development. A
 * weaker id there is fine; these values are telemetry, never security.
 */
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name}=([^;]*)`),
  );
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // decodeURIComponent throws URIError on a malformed escape -- a bare
    // "%" is enough. Cookies outlive this code and can be set by anything
    // on the domain, so this is reachable without any bug of ours.
    //
    // Unhandled, it threw inside getSessionId(), propagated through
    // correlationHeaders(), and broke fetchProductsPaged BEFORE the
    // request was issued: one stale cookie would have emptied the product
    // listing. Telemetry must never be able to do that -- an unreadable
    // id is simply a missing id, and a fresh one replaces it.
    return undefined;
  }
}

function writeSessionCookie(value: string): void {
  if (typeof document === "undefined") return;
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "path=/",
    `max-age=${SESSION_IDLE_MINUTES * 60}`,
    "SameSite=Lax",
    // Secure everywhere except plain-http local development, where the
    // browser would otherwise refuse to store it at all.
    ...(location.protocol === "https:" ? ["Secure"] : []),
  ];
  document.cookie = attrs.join("; ");
}

/**
 * The current session id, creating one on first use.
 *
 * A cookie rather than sessionStorage for two reasons: it survives across
 * tabs (sessionStorage does not, so a user opening a product in a new tab
 * would look like a second session), and it is readable during server
 * rendering, which sessionStorage never is.
 *
 * Deliberately NOT HttpOnly -- this file has to read it to attach the
 * header. That is an accepted trade-off because the value is an anonymous,
 * opaque telemetry id: it grants nothing, identifies no one, and carries
 * no privilege if read.
 *
 * Re-writing the cookie on every read is what makes the 30 minutes a
 * ROLLING idle window rather than a hard cap -- an active user is never
 * cut off mid-visit, while an abandoned tab expires.
 */
export function getSessionId(): string {
  const existing = readCookie(SESSION_COOKIE);
  // Also rejects a value that survived decoding but is not id-shaped: the
  // API drops anything outside [A-Za-z0-9_-] to prevent log injection, so
  // reusing such a value would mean sending a session id that is silently
  // discarded on arrival -- the session would look absent in the data
  // while appearing present in the browser.
  const usable = existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing) ? existing : undefined;
  const id = usable ?? newId();
  writeSessionCookie(id);
  return id;
}

let pageViewId: string | undefined;

/**
 * The id for the current navigation.
 *
 * Module-scoped rather than stored: a page view ends when the document
 * does. On a client-side route change call newPageView() to start a new
 * one -- this app is a single-page app after hydration, so navigations do
 * not reload the document and would otherwise share one id for the whole
 * visit.
 */
export function getPageViewId(): string {
  pageViewId ??= newId();
  return pageViewId;
}

/** Starts a new page view, returning its id. */
export function newPageView(): string {
  pageViewId = newId();
  return pageViewId;
}

/**
 * Headers to attach to an outbound API call.
 *
 * Takes the client request id as an argument rather than generating it
 * here, so the caller keeps the value it needs to log a failure against.
 */
export function correlationHeaders(clientRequestId: string): Record<string, string> {
  // On the server there is no session and no page view -- this code runs
  // once per render, not once per user. Generating them here would mint a
  // brand-new "session" on every server-rendered request, flooding the
  // data with single-request sessions that never existed. So SSR sends
  // only the per-call id, and the correct fix for a real server-to-server
  // hop is forwarding the INBOUND correlation, which needs a trust signal
  // first (see apps/api/src/observability/correlation.middleware.ts).
  if (typeof document === "undefined") {
    return { [CORRELATION_HEADERS.clientRequestId]: clientRequestId };
  }
  return {
    [CORRELATION_HEADERS.sessionId]: getSessionId(),
    [CORRELATION_HEADERS.pageViewId]: getPageViewId(),
    [CORRELATION_HEADERS.clientRequestId]: clientRequestId,
  };
}

/** A fresh id for one outbound call. */
export function newClientRequestId(): string {
  return newId();
}
