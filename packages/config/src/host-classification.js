/**
 * Host classification: is this address reachable from outside the machine
 * that issued it?
 *
 * MOVED HERE from apps/web/src/lib/site-url.ts, which is where it was
 * written and thoroughly tested. web-runtime.js had its own list
 * -- four exact strings -- which accepted `127.0.0.2` and
 * every other address in 127.0.0.0/8, plus every private range and every
 * IPv4-mapped-IPv6 spelling the real version already handled.
 *
 * Two copies of "is this address public", one thorough and one not, is the
 * drift this package exists to prevent. Both guards import these now: the
 * one in web-runtime.js, which covers every import path, and the richer one
 * in site-url.ts that next.config.ts runs at build and boot.
 *
 * Kept dependency-free like the rest of packages/config: scripts/ci-env.mjs
 * imports the contract by relative path with no node_modules present.
 */

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
export function isUnreachableIpv4(hostname) {
  const m = IPV4.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  return (
    a === 127 || a === 10 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    // Deterministically non-public even though they are not "local". This is
    // now the WHOLE IANA IPv4 Special-Purpose Address Registry, not a
    // growing list of the ones somebody happened to notice -- three review
    // rounds each added another range (127.0.0.0/8, then fec0::/10, then
    // 192.0.0.0/24), which is the signal that enumerating instances was the
    // wrong shape. The registry is finite; the list of things people can
    // think of is not.
    //
    // CGNAT (100.64/10).
    (a === 100 && b >= 64 && b <= 127) ||
    // IETF Protocol Assignments (192.0.0.0/24). Two addresses inside it --
    // 192.0.0.8/9, PCP anycast -- are technically globally reachable, but
    // nothing serves a website there, and treating the /24 as unusable is
    // the safe direction for a guard whose failure mode is a dead URL.
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    // TEST-NET-1/2/3, reserved for documentation.
    (a === 192 && b === 0 && Number(m[3]) === 2) ||
    (a === 198 && b === 51 && Number(m[3]) === 100) ||
    (a === 203 && b === 0 && Number(m[3]) === 113) ||
    // 6to4 relay anycast (192.88.99.0/24), deprecated by RFC 7526.
    (a === 192 && b === 88 && Number(m[3]) === 99) ||
    // Benchmarking (198.18/15).
    (a === 198 && (b === 18 || b === 19)) ||
    // Multicast (224-239) and reserved/broadcast (240+, which includes
    // 255.255.255.255).
    a >= 224
  );
}

/**
 * True for an IPv6 literal that is loopback (::1), unspecified (::),
 * unique-local (fc00::/7) or link-local (fe80::/10). URL.hostname keeps
 * the surrounding brackets for IPv6, so they are stripped first.
 */
export function isUnreachableIpv6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1).toLowerCase();
  if (addr === "::1" || addr === "::") return true;

  // IPv4-mapped addresses (::ffff:127.0.0.1, and its canonical hex form
  // ::ffff:7f00:1) resolve to the embedded IPv4 address, so they must go
  // through the IPv4 range checks -- otherwise every private and loopback
  // address has a trivial spelling that walks straight past this guard.
  const mapped = mappedIpv4(addr);
  if (mapped) return isUnreachableIpv4(mapped);

  return (
    // fc00::/7 (unique-local) covers fc and fd.
    /^f[cd][0-9a-f]{0,2}:/.test(addr) ||
    // fe80::/10 (link-local) covers fe8 through feb.
    /^fe[89ab][0-9a-f]?:/.test(addr) ||
    // fec0::/10 (site-local). DEPRECATED by RFC 3879 and therefore easy to
    // leave out -- but deprecated means routers may ignore it, not that
    // nobody types it, and an address the internet will not route is exactly
    // what this function exists to catch.
    /^fe[cdef][0-9a-f]?:/.test(addr) ||
    // ff00::/8 multicast -- an address a browser cannot fetch a page from.
    /^ff[0-9a-f]{0,2}:/.test(addr) ||
    // 2001:db8::/32, reserved for documentation and examples. Not routable,
    // and a very plausible copy-paste out of a tutorial.
    /^2001:0?db8:/.test(addr) ||
    // Discard-Only (100::/64, RFC 6666) -- traffic is dropped by design.
    /^100:(?::|0{1,4}:)/.test(addr) ||
    // Local-use IPv4/IPv6 translation (64:ff9b:1::/48, RFC 8215).
    /^64:ff9b:1:/.test(addr) ||
    // 6to4 (2002::/16). Reachable only through relays that RFC 7526
    // deprecated, so in practice a dead address.
    /^2002:/.test(addr)
  );
}

/** The embedded IPv4 of a `::ffff:` address, in dotted form, else null. */
function mappedIpv4(addr) {
  const tail = /^::ffff:(.+)$/.exec(addr)?.[1];
  if (!tail) return null;
  if (tail.includes(".")) return tail; // already dotted: ::ffff:127.0.0.1

  // Hex form: ::ffff:7f00:1 -> two groups, four bytes.
  const groups = tail.split(":");
  if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const [hi, lo] = groups.map((g) => parseInt(g, 16));
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}
