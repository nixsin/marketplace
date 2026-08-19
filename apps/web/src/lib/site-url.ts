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

/**
 * Hosts no recipient of a shared link could open.
 *
 * "localhost" plus a trailing dot is the fully-qualified form of the same
 * name and resolves identically, so it has to be covered too -- listing
 * only the bare name would let `http://localhost./` through.
 */
const LOCAL_HOSTNAMES = /^(localhost\.?|\[::1\]|::1)$/i;

/**
 * Address ranges that are unreachable from outside the network that
 * issued them: loopback (127/8), RFC1918 private (10/8, 172.16-31/16,
 * 192.168/16), link-local (169.254/16) and the unspecified address.
 *
 * A build pointed at one of these is not merely wrong, it is wrong in a
 * way that looks fine to whoever deployed it -- the links work on their
 * machine and resolve to a stranger's router, or nothing, for everyone
 * else. Exactly the failure mode this guard exists to prevent, so the
 * check covers the whole class rather than the handful of literals that
 * happen to come to mind.
 */
const UNREACHABLE_IPV4 =
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(1[6-9]|2\d|3[01])\.)/;

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
  if (LOCAL_HOSTNAMES.test(url.hostname) || UNREACHABLE_IPV4.test(url.hostname)) {
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
