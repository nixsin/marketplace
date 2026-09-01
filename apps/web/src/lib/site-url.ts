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
const LOCAL_HOSTNAMES = /^localhost\.?$/i;

// Host classification lives in @medinstru/config now.
//
// It was written here and is thorough -- 127.0.0.0/8, RFC1918, link-local,
// CGNAT, the TEST-NET ranges, multicast, and IPv4-mapped IPv6 in both dotted
// and hex spellings. env-contract.js had grown its own four-entry version,
// which accepted 127.0.0.2 and every private address. Sharing one definition
// is the point of that package; this file keeps the MESSAGES, which are its
// own contribution.
import {
  isUnreachableIpv4,
  isUnreachableIpv6,
} from "@medinstru/config/host-classification";

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

  // NOTE ON WHAT THESE MESSAGES MAY CONTAIN.
  //
  // This string is thrown from next.config.ts, so it lands in a build log
  // that is far more widely readable than the environment variable it
  // describes. Echoing the raw value back would therefore publish anything
  // embedded in it -- `https://user:secret@localhost` or
  // `https://example.com/?token=...` are exactly the shapes that get pasted
  // into a config field by mistake, and the credentials branch below only
  // ran AFTER the local-address branch, so the password was already in the
  // message by then.
  //
  // So: no branch echoes the whole value. Each names only the component
  // that is actually wrong, and the credential and query CONTENTS are never
  // included -- only the fact that they are present.
  if (!URL.canParse(value)) {
    // Deliberately no value: an unparseable string cannot be decomposed
    // into safe and unsafe parts, and the variable's name is already in
    // the message, which is enough to go and look at it.
    return "it is not a valid URL";
  }

  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) {
    return `it must be an http(s) URL, but its scheme is "${url.protocol.replace(":", "")}"`;
  }

  // Before the host check, so a credential in a local-address URL is never
  // echoed by the branch below.
  //
  // Credentials would also be carried into every share link and og:image
  // URL, publishing them to whoever the page is forwarded to. Rejected
  // outright rather than stripped: silently repairing it would hide that a
  // secret was pasted into a build variable in the first place.
  if (url.username || url.password) {
    return "it contains credentials, which would be published in every shared link";
  }

  const host = url.hostname;
  if (LOCAL_HOSTNAMES.test(host) || isUnreachableIpv4(host) || isUnreachableIpv6(host)) {
    return `it points at a local address, which no recipient can open: ${host}`;
  }

  // This is an ORIGIN, and productShareUrl uses it as a base to resolve
  // "/<locale>/products/<id>" against -- so a path, query or fragment here
  // is silently discarded, and whoever set it would have no idea. Rejecting
  // says so plainly. A bare trailing slash is the same origin, so allowed.
  //
  // Names which component offends, never its contents -- a query string is
  // one of the likeliest places for a token to be hiding.
  const extras = [
    url.pathname !== "/" ? "a path" : null,
    url.search ? "a query string" : null,
    url.hash ? "a fragment" : null,
  ].filter(Boolean);
  if (extras.length) {
    return `it must be a bare origin, but it has ${extras.join(" and ")} (origin: ${url.origin})`;
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
