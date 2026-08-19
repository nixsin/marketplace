/**
 * Validation for NEXT_PUBLIC_SITE_URL on a deployed build.
 *
 * Extracted from next.config.ts and unit-tested for the same reason
 * security-headers.ts was (see CLAUDE.md): next.config.ts is the file
 * Next.js itself loads to boot, so it cannot be imported and exercised by
 * an ordinary test. Logic that decides whether a deploy is allowed to
 * proceed should not be the one part of the codebase verified only by
 * hand.
 *
 * Why this exists at all: SITE_URL is inlined at build time and cannot be
 * corrected at runtime. It shipped unset once, so every WhatsApp share
 * link and every og:image pointed at http://localhost:3000 -- dead for the
 * recipient, in the one feature whose entire job is being forwarded to
 * someone else. render.yaml declares the right value but is
 * documentation-only, not an active Blueprint sync, so nothing enforced
 * it.
 *
 * Absence is not the only failure. A value that is present but wrong -- a
 * leftover localhost, a stray paste, whitespace -- produces exactly the
 * same dead links while satisfying a guard that only checks for unset.
 */

/** Hosts that no recipient of a shared link could ever open. */
const LOCAL_HOSTNAMES = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;

/**
 * Returns a human-readable reason the value is unusable, or null if it is
 * a valid public origin.
 *
 * Returning the reason rather than a boolean so the thrown build error can
 * say what is actually wrong -- a deploy blocked at 2am should not require
 * reading this source to interpret.
 */
export function siteUrlProblem(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return "it is not set";
  if (!URL.canParse(value)) return `it is not a valid URL: ${value}`;

  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) {
    return `it must be an http(s) URL, got: ${value}`;
  }
  if (LOCAL_HOSTNAMES.test(url.hostname)) {
    return `it points at a local address, which no recipient can open: ${value}`;
  }
  return null;
}

/** The full build-failure message, kept next to the rule it explains. */
export function siteUrlErrorMessage(problem: string): string {
  return (
    `NEXT_PUBLIC_SITE_URL is unusable for this deployed build -- ${problem}. ` +
    "It is inlined at build time and cannot be fixed at runtime, so every " +
    "shared link and OpenGraph image would point somewhere the recipient " +
    "cannot reach. Set it to this service's public origin in the Render " +
    "dashboard, then redeploy."
  );
}
