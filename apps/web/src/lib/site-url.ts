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

/** A complete dotted-quad, so range checks apply only to real IP literals. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True for an IPv4 address unreachable from outside the network that
 * issued it: loopback (127/8), RFC1918 private (10/8, 172.16-31, 192.168/16),
 * link-local (169.254/16), and the unspecified address.
 *
 * Deliberately NOT a prefix match on the hostname string. A first attempt
 * tested /^(10\.|127\.|...)/ against the raw hostname, which also matches
 * perfectly good public names like `10.example.com` or `172.16.example.com`
 * -- blocking a valid deploy, which is the worse failure of the two this
 * guard sits between. Parsing the quad first makes the range check apply
 * only to something that is actually an address.
 */
function isUnreachableIpv4(hostname: string): boolean {
  const m = IPV4.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  return (
    a === 127 || a === 10 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    // Deterministically non-public even though they are not "local":
    // CGNAT (100.64/10), TEST-NET documentation ranges (192.0.2, 198.51.100,
    // 203.0.113), benchmarking (198.18/15), multicast (224-239) and
    // reserved/broadcast (240+, which includes 255.255.255.255).
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && Number(m[3]) === 2) ||
    (a === 198 && b === 51 && Number(m[3]) === 100) ||
    (a === 203 && b === 0 && Number(m[3]) === 113) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * True for an IPv6 literal that is loopback (::1), unspecified (::),
 * unique-local (fc00::/7) or link-local (fe80::/10). URL.hostname keeps
 * the surrounding brackets for IPv6, so they are stripped first.
 */
function isUnreachableIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1).toLowerCase();
  if (addr === "::1" || addr === "::") return true;

  // IPv4-mapped addresses (::ffff:127.0.0.1, and its canonical hex form
  // ::ffff:7f00:1) resolve to the embedded IPv4 address, so they must go
  // through the IPv4 range checks -- otherwise every private and loopback
  // address has a trivial spelling that walks straight past this guard.
  const mapped = mappedIpv4(addr);
  if (mapped) return isUnreachableIpv4(mapped);

  // fc00::/7 covers fc and fd; fe80::/10 covers fe8 through feb.
  return /^f[cd][0-9a-f]{0,2}:/.test(addr) || /^fe[89ab][0-9a-f]?:/.test(addr);
}

/** The embedded IPv4 of a `::ffff:` address, in dotted form, else null. */
function mappedIpv4(addr: string): string | null {
  const tail = /^::ffff:(.+)$/.exec(addr)?.[1];
  if (!tail) return null;
  if (tail.includes(".")) return tail; // already dotted: ::ffff:127.0.0.1

  // Hex form: ::ffff:7f00:1 -> two groups, four bytes.
  const groups = tail.split(":");
  if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const [hi, lo] = groups.map((g) => parseInt(g, 16));
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

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
  const host = url.hostname;
  if (LOCAL_HOSTNAMES.test(host) || isUnreachableIpv4(host) || isUnreachableIpv6(host)) {
    return `it points at a local address, which no recipient can open: ${value}`;
  }

  // Credentials would be carried into every share link and og:image URL,
  // publishing them to whoever the page is forwarded to. That is a leak,
  // not a formatting mistake, so it is rejected outright rather than
  // stripped -- silently repairing it would hide that a secret was pasted
  // into a build variable in the first place.
  if (url.username || url.password) {
    return "it contains credentials, which would be published in every shared link";
  }

  // This is an ORIGIN, and productShareUrl uses it as a base to resolve
  // "/<locale>/products/<id>" against -- so a path, query or fragment here
  // is silently discarded, and whoever set it would have no idea. Rejecting
  // says so plainly. A bare trailing slash is the same origin, so allowed.
  if (url.pathname !== "/" || url.search || url.hash) {
    return `it must be a bare origin with no path, query or fragment: ${value}`;
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
