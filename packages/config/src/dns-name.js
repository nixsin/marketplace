/**
 * Is this hostname a name the public internet can resolve?
 *
 * WHY THIS IS NOT AN IP-RANGE CHECK. Five review rounds went into
 * enumerating IANA special-purpose address ranges -- fec0::/10, 100::/64,
 * 2001:2::/48, 3fff::/20, ORCHIDv2 -- and the list is unbounded, because
 * IANA keeps assigning blocks (3fff::/20 landed in 2024).
 *
 * None of it was needed. A public URL is always a DNS name: an IP literal
 * cannot get a certificate from the CDN in front of it. Requiring a name
 * rejects every literal in both families at once, rejects single-label
 * internal names, and cannot be defeated by a range that does not exist yet.
 *
 * EVERY LABEL USES THE SAME RULE, including the last. Special-casing the top
 * label as "letters only" rejected punycode (`xn--zckzah`); widening it to
 * `xn--[a-z0-9]+` then rejected punycode with an internal hyphen, which is
 * most of it -- the encoding uses `-` as its delimiter, so `münchen` becomes
 * `xn--mnchen-3ya`. The only thing the top label may not be is all digits,
 * which is what separates `example.com` from the literal `1.2.3.4`.
 *
 * NOT for internal hostnames. Render's own Postgres answers on
 * `dpg-…-a` -- a single label with no dot -- which is correct there and
 * fails this deliberately. See `isLoopbackHost` for that case.
 *
 * @param {string} hostname  As given by `URL.hostname`, so IPv6 keeps its brackets.
 * @returns {boolean}
 */
export function isPublicDnsName(hostname) {
  // A trailing dot is the fully-qualified form of the same name.
  const host = hostname.replace(/\.$/, "");

  // 253 is DNS's presentation-format limit for a whole name. The per-label
  // rule caps each label at 63 but says nothing about how many there are.
  if (host.length > 253) return false;

  const labels = host.split(".");
  if (labels.length < 2) return false;

  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (!labels.every((label) => LABEL.test(label))) return false;

  // An all-numeric top label means this is an IPv4 literal, not a name.
  if (/^\d+$/.test(labels[labels.length - 1])) return false;

  // SPECIAL-USE SUFFIXES ARE NOT PUBLIC NAMES. `api.localhost` is two
  // syntactically valid labels with a non-numeric top label, so every rule
  // above accepts it -- and RFC 6761 requires resolvers to answer it with
  // loopback. It points a visitor at their own machine just as surely as
  // `localhost` does, which is the failure this whole check exists for.
  //
  // A short, standards-defined list, unlike the IANA address registry this
  // replaced: these are reserved by RFC and do not grow with allocation.
  return !RESERVED_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * Suffixes that never resolve on the public internet.
 *
 * RFC 6761 (`test`, `example`, `invalid`, `localhost`, `onion`), RFC 6762
 * (`local`, mDNS), RFC 8375 (`home.arpa`), RFC 9476 (`alt`), and `internal`,
 * which ICANN reserved for private use in 2024.
 *
 * `onion` and `alt` were omitted at first on the grounds that nothing here
 * would be served over Tor -- true, and beside the point: the question this
 * function answers is "can the public internet resolve this", and neither
 * can be. Including them costs two strings and removes a judgement call from
 * a list that is otherwise purely mechanical.
 *
 * The second group is private-use suffixes that are not RFC-reserved but are
 * conventional on corporate networks. `corp`, `home` and `mail` are the
 * three ICANN permanently withheld from delegation in 2018 after measuring
 * the name-collision risk; the rest have never been delegated and are used
 * on internal networks by convention.
 *
 * WHAT THIS LIST IS NOT is a completeness claim. Deciding whether an
 * arbitrary suffix is publicly delegated needs the Public Suffix List --
 * thousands of entries, revised continuously, so vendoring it trades this
 * gap for a staleness problem that fails in the same direction. This
 * denylist catches the suffixes that actually get typed into a production
 * config by accident. The backstop for everything else is that an
 * undelegated name does not resolve, so the deploy fails loudly rather
 * than silently pointing at nothing.
 */
const RESERVED_SUFFIXES = [
  // RFC-reserved.
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
  "home.arpa",
  "onion",
  "alt",
  // Private use by convention, never delegated.
  "corp",
  "home",
  "mail",
  "lan",
  "intranet",
  "localdomain",
];

/**
 * Is this hostname the machine asking the question?
 *
 * The weaker, separate check for INTERNAL hosts -- a database or cache URL,
 * where a single-label name is normal and correct. Only loopback is wrong
 * there, and only `localhost` occurs in practice: it is what a developer's
 * .env says, and copying that into production is the mistake this catches.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  const addr = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // IPv4-MAPPED SPELLINGS TOO. `[::ffff:127.0.0.1]` and its hex form
  // `[::ffff:7f00:1]` are loopback wearing an IPv6 costume, and a check that
  // only knows `127.` and `::1` lets both through -- which is the whole
  // trick, since anything a resolver accepts a caller can write.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr)?.[1];
  if (mappedDotted) return /^127\./.test(mappedDotted);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) return parseInt(mappedHex[1], 16) >> 8 === 127;

  return (
    /^localhost\.?$/i.test(addr) ||
    /^127\./.test(addr) ||
    addr === "::1" ||
    // THE UNSPECIFIED ADDRESSES, both families. `0.0.0.0` means "every
    // interface on this machine" to a server binding it and "this host" to
    // anything connecting, so `postgresql://u:p@0.0.0.0/db` in production
    // names no remotely reachable service -- the same failure as `localhost`
    // wearing a different spelling. `::` is its IPv6 counterpart.
    addr === "::" ||
    addr === "0.0.0.0"
  );
}
