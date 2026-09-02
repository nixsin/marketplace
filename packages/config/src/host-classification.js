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
 * True for an IPv6 literal that is not globally reachable.
 *
 * INVERTED, and that is the point. Four review rounds each added one more
 * non-global range -- fec0::/10, then 100::/64 and 64:ff9b:1::/48, then
 * 2001:2::/48 and 3fff::/20. Enumerating what is bad is unbounded: IANA is
 * still assigning these (3fff::/20 was allocated in 2024), so the list is
 * guaranteed to be out of date again.
 *
 * Global unicast is exactly 2000::/3. Everything outside it -- loopback,
 * unspecified, unique-local, link-local, site-local, multicast, discard-only,
 * translation prefixes, and every block IANA assigns next -- is not globally
 * reachable, with no list to maintain. Only the exceptions INSIDE 2000::/3
 * need naming, and there are five.
 *
 * URL.hostname keeps the brackets for IPv6, so they are stripped first.
 */
export function isUnreachableIpv6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1).toLowerCase();

  // IPv4-mapped addresses (::ffff:127.0.0.1, and its canonical hex form
  // ::ffff:7f00:1) resolve to the embedded IPv4 address, so they must go
  // through the IPv4 range checks -- otherwise every private and loopback
  // address has a trivial spelling that walks straight past this guard.
  // Handled BEFORE the 2000::/3 test, which would otherwise call a mapped
  // PUBLIC address unreachable.
  const mapped = mappedIpv4(addr);
  if (mapped) return isUnreachableIpv4(mapped);

  const firstHextet = /^([0-9a-f]{0,4})(?::|$)/.exec(addr)?.[1];
  if (firstHextet === undefined) return true; // unparseable: fail closed
  // A leading `::` means the first group is zero -- ::1, :: and friends, all
  // outside global unicast.
  const high = firstHextet === "" ? 0 : parseInt(firstHextet, 16);

  // Outside 2000::/3 is not globally reachable, whatever it is.
  if (high < 0x2000 || high > 0x3fff) return true;

  // The exceptions inside global unicast. This list IS bounded: a block only
  // belongs here if IANA carved it out of 2000::/3 specifically.
  return (
    // 2001:db8::/32 -- documentation. A very plausible copy-paste from a
    // tutorial, which is why it was the first one anybody noticed.
    /^2001:0?db8:/.test(addr) ||
    // 2001:2::/48 -- benchmarking (RFC 5180).
    /^2001:0{0,3}2:/.test(addr) ||
    // 2001::/32 -- Teredo. Globally routable in principle, but it is a
    // tunnelling transition mechanism, not somewhere a service is hosted.
    /^2001:0{0,4}(?::|$)/.test(addr) ||
    // 2002::/16 -- 6to4, reachable only through relays RFC 7526 deprecated.
    /^2002:/.test(addr) ||
    // 3fff::/20 -- documentation (RFC 9637, allocated 2024). The range that
    // made the case for inverting this function rather than extending it.
    //
    // /20 is the first hextet PLUS the top nibble of the second, so the
    // second group must start with 0. A first attempt matched `3ff[0-9a-f]:`
    // and swept in 3ffe::/16 -- the decommissioned 6bone, since returned to
    // IANA as ordinary unallocated space, not special-purpose.
    /^3fff:(?::|0)/.test(addr)
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
