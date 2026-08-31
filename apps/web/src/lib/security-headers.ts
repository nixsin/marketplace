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
  /**
   * The origin this build will actually be served from.
   *
   * Decides whether `upgrade-insecure-requests` is emitted. Gating that on
   * `isDev` alone was wrong: a PRODUCTION build served over plain HTTP --
   * which is exactly what CI does for the e2e suite -- still carried the
   * directive, so every sub-resource was rewritten to https:// against a
   * server with no TLS.
   *
   * Chromium hides this, because it exempts localhost from the upgrade.
   * WebKit does not, and fails every request with "A TLS error caused the
   * secure connection to fail." Verified directly in both engines against
   * the same local server; the whole page renders in one and is blank in
   * the other. CLAUDE.md had flagged the localhost exemption as unverified
   * -- it is now verified, and engine-dependent.
   */
  siteUrl: string;
  /**
   * REQUIRED, and not `string | undefined` any more.
   *
   * It used to be optional so callers could pass
   * `process.env.NEXT_PUBLIC_API_URL` straight through, with the fallback
   * resolved here -- one definition of "no env var set", shared with
   * src/lib/api.ts. That reasoning stopped holding when the fallback was
   * removed: there is now no such thing as "no env var set" that anything
   * downstream should tolerate, so the type says so and callers pass
   * `API_URL` from `@medinstru/config/web`, which throws when it is unset.
   */
  apiUrl: string;
  /**
   * Public base URL for blob-stored images, when one is configured.
   *
   * Passed in rather than read here, matching apiUrl above: one definition
   * of "not configured" lives at the call site, not two. Undefined or
   * empty means images are still served from this origin, so no extra
   * img-src entry is emitted and the policy stays as tight as it is today.
   */
  blobBaseUrl?: string | undefined;
}

/**
 * The extra img-src entry for a blob host, or "" when unset.
 *
 * Only the ORIGIN is allowed, never the full base URL -- a CSP source with
 * a path is matched by prefix, which is both broader than intended and a
 * common way to write a policy that silently permits more than it reads
 * like it does. Falls back to "" on an unparseable value so a bad env var
 * degrades to a stricter policy, never a broken page.
 */
export function blobImgSrcEntry(blobBaseUrl: string | undefined): string {
  if (!blobBaseUrl) return "";
  try {
    return ` ${new URL(blobBaseUrl).origin}`;
  } catch {
    return "";
  }
}

/**
 * NO FALLBACK. This used to read `apiUrl ?? "http://localhost:4000/graphql"`,
 * which meant a missing NEXT_PUBLIC_API_URL silently produced a CSP whose
 * `connect-src` allowed localhost and nothing else -- so the browser blocked
 * every real API call, and the header that caused it looked deliberate.
 *
 * The value is now required at the type level and at runtime, and callers get
 * it from `@medinstru/config/web`, which throws when it is unset.
 */
export function computeApiOrigin(apiUrl: string): string {
  if (!apiUrl) {
    throw new Error(
      "computeApiOrigin needs NEXT_PUBLIC_API_URL. There is no default: a " +
        "localhost fallback here produces a CSP that blocks every real API " +
        "call while looking intentional.",
    );
  }
  return new URL(apiUrl).origin;
}

export function buildCspHeader({
  isDev,
  siteUrl,
  apiUrl,
  blobBaseUrl,
}: SecurityHeadersInput): string {
  const apiOrigin = computeApiOrigin(apiUrl);
  // Emitted only when the site is genuinely served over HTTPS. Upgrading
  // sub-resources on an http:// origin cannot succeed -- there is nothing
  // listening on TLS -- so the directive would only ever break the page.
  const upgradeInsecure = !isDev && siteUrl.startsWith("https://");
  const blobImgSrc = blobImgSrcEntry(blobBaseUrl);
  return `
    default-src 'self';
    script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data:${blobImgSrc};
    font-src 'self';
    connect-src 'self' ${apiOrigin};
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';${upgradeInsecure ? " upgrade-insecure-requests;" : ""}
  `
    .replace(/\s{2,}/g, " ")
    .trim();
}

// `preload` deliberately omitted -- it means submitting this domain to
// browsers' hardcoded HSTS preload lists, which is effectively
// irreversible. Add it later once this has been confirmed stable in
// production for a while. Not environment-dependent, so not a function --
// a plain constant is the honest shape for it.
// Re-exported, not redeclared: the value itself lives in
// @medinstru/config alongside every other header value, so a change to
// the HSTS lifetime cannot land here while a doc or another consumer
// keeps the old number. This module keeps the ENVIRONMENT logic (when
// HSTS may be emitted at all) which is what its tests exercise.
import { HSTS_HEADER_VALUE } from "@medinstru/config";

export { HSTS_HEADER_VALUE };

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
