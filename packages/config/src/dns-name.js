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
 * RFC 6761 (`test`, `example`, `invalid`, `localhost`), RFC 6762 (`local`,
 * mDNS), RFC 8375 (`home.arpa`), and `internal`, which ICANN reserved for
 * private use in 2024. `onion` and `alt` are omitted deliberately: they are
 * reserved, but nothing here would ever be served over Tor, and listing
 * names for their own sake is what made the previous check unmaintainable.
 */
const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
  "home.arpa",
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
  return (
    /^localhost\.?$/i.test(hostname) ||
    /^127\./.test(hostname) ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
