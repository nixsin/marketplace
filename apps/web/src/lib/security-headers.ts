// Pure header-generation logic for next.config.ts's headers() block,
// extracted specifically so it's unit-testable -- an AI review on the PR
// that introduced these headers flagged that manual verification
// (documented in CLAUDE.md) isn't repeatable regression coverage, and was
// right: this is security-critical, environment-dependent logic (dev vs.
// prod CSP directives, the API origin interpolated into connect-src) that
// could silently regress (e.g. 'unsafe-eval' leaking into a production
// build, or upgrade-insecure-requests breaking local dev against a local
// API) without a loud failure. See next.config.ts's own comments for the
// full reasoning behind each directive -- this file is just the pure
// computation, kept in sync with that reasoning, not a duplicate of it.

export interface SecurityHeadersInput {
  isDev: boolean;
  // Matches src/lib/api.ts's own NEXT_PUBLIC_API_URL fallback exactly --
  // callers should pass process.env.NEXT_PUBLIC_API_URL as-is (including
  // undefined) rather than pre-resolving the fallback themselves, so both
  // places only ever have one definition of what "no env var set" means.
  apiUrl: string | undefined;
}

export function computeApiOrigin(apiUrl: string | undefined): string {
  return new URL(apiUrl ?? "http://localhost:4000/graphql").origin;
}

export function buildCspHeader({ isDev, apiUrl }: SecurityHeadersInput): string {
  const apiOrigin = computeApiOrigin(apiUrl);
  return `
    default-src 'self';
    script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data:;
    font-src 'self';
    connect-src 'self' ${apiOrigin};
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';${isDev ? "" : " upgrade-insecure-requests;"}
  `
    .replace(/\s{2,}/g, " ")
    .trim();
}

// `preload` deliberately omitted -- it means submitting this domain to
// browsers' hardcoded HSTS preload lists, which is effectively
// irreversible. Add it later once this has been confirmed stable in
// production for a while. Not environment-dependent, so not a function --
// a plain constant is the honest shape for it.
export const HSTS_HEADER_VALUE = "max-age=63072000; includeSubDomains";

// Whether the header is *emitted at all* is environment-dependent, even
// though its value isn't -- caught by an AI review: HSTS was being added
// unconditionally, unlike CSP's own isDev-gated directives. A browser
// persists HSTS per hostname for the full max-age once it sees the
// header even once, then refuses plain HTTP to that host until it
// expires -- genuinely disruptive for a local dev server ever accessed
// over HTTPS (e.g. via a local TLS proxy), not just a theoretical
// mismatch. A plain isDev check inlined in next.config.ts would have
// left this exact same gap invisible to tests again, the same problem
// that got buildCspHeader extracted in the first place -- so this is a
// function, not a conditional at the call site, specifically so the
// gating itself is unit-tested, not just the header value's contents.
export function hstsHeaderEntries(isDev: boolean): { key: string; value: string }[] {
  if (isDev) return [];
  return [{ key: "Strict-Transport-Security", value: HSTS_HEADER_VALUE }];
}
