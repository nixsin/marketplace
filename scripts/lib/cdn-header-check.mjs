// Pure logic behind the synthetic CDN-vs-origin header check that #78 §1.2
// calls for: "the CDN must respect origin Cache-Control, never override
// it."
//
// Scope, stated honestly (a real AI review caught the original version of
// this file overstating it): this catches a CDN that silently *rewrites or
// strips* the Cache-Control header value on its way through -- a real,
// common misconfiguration class ("cache everything regardless of origin
// headers" is a common CDN dashboard default). It does NOT catch a CDN
// that forwards the header unchanged while its own cache internally
// ignores what that header says (e.g. serving a stale hit from its own
// cache well past what must-revalidate/max-age actually allows, even
// though the response it eventually returns still carries the original,
// unmodified header). Detecting that needs *behavioral* verification --
// a controlled origin content change followed by repeated CDN requests,
// checking whether the CDN's response reflects the change on the expected
// schedule -- which needs a real CDN in the loop to design and verify
// against, not just two URLs. Out of scope for this domain-independent
// prep pass; worth a follow-up once #78 Part 1's CDN actually exists.
//
// No CDN/domain exists yet (#78 Part 1's own blocking prerequisite) -- this
// is the domain-independent half: the comparison logic itself, built and
// tested now, with a thin CLI wrapper (verify-cdn-headers.mjs) that takes
// two real URLs once there's an actual CDN endpoint to point it at.

// The headers a misbehaving CDN could silently rewrite in a way that
// changes real caching/freshness behavior. Not Vary, ETag, or Date --
// those can legitimately differ (a CDN may add its own weak validator, or
// the two requests simply don't land in the same second) without meaning
// the CDN overrode anything origin actually asked for.
const FRESHNESS_HEADERS = ["cache-control"];

// origin/cdn: plain records (lowercase keys) of the headers each response
// actually returned -- callers normalize a real Headers object down to
// this shape (see verify-cdn-headers.mjs) so this function stays a pure
// comparison with no fetch/network dependency of its own.
export function compareCacheHeaders(originHeaders, cdnHeaders) {
  const mismatches = [];
  for (const key of FRESHNESS_HEADERS) {
    const originValue = originHeaders[key];
    const cdnValue = cdnHeaders[key];
    if (originValue !== cdnValue) {
      mismatches.push({ header: key, origin: originValue, cdn: cdnValue });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Full decision for one checked path, covering the real gaps two live AI
// review rounds found in the original header-only version:
//
// 1. Comparing headers is meaningless if either request itself failed --
//    two error responses can trivially carry the same (absent)
//    Cache-Control and compare as "ok", silently passing a check that
//    never actually exercised anything. Both status codes are checked
//    directly, before headers are ever compared.
// 2. A CDN URL that redirects straight through to the origin's own actual
//    destination proves nothing about the CDN's own behavior --
//    fetch()'s `redirect: "follow"` makes this invisible unless the
//    *final* URL is checked against where the request was actually sent.
//    Both origin and CDN legs are treated symmetrically here (request URL
//    vs. final URL after any redirect) -- a first version of this
//    compared the CDN's *final* host against the origin's *requested*
//    host, which a second review round caught as its own gap: if origin
//    itself redirects (origin.example.com -> app.example.com) and the CDN
//    also redirects straight to that same real destination, comparing
//    against the origin's merely-requested host would miss it, since
//    app.example.com never equals origin.example.com.
//
// All inputs are plain values (no Response/Headers objects) so this stays
// a pure function the CLI wrapper's fetch results get normalized into --
// see verify-cdn-headers.mjs.
export function evaluateCdnCheck({
  originRequestUrl,
  originFinalUrl,
  originStatus,
  originHeaders,
  cdnRequestUrl,
  cdnFinalUrl,
  cdnStatus,
  cdnHeaders,
}) {
  const problems = [];

  // Strictly 2xx, not the earlier >=200 && <400 -- a third review round
  // caught that a 3xx surviving as the *final* status (redirect:"follow"
  // doesn't blindly follow every 3xx, e.g. 300 Multiple Choices has no
  // single Location to follow, and a stray 304 outside a real conditional
  // request isn't a legitimate response to a plain GET here) means
  // neither side actually returned the real resource -- there's nothing
  // meaningful to compare, the same reasoning already applied to a hard
  // 4xx/5xx failure.
  // 204 and 205 are deliberately excluded from the "ok" range too (an
  // eighth review round found 204, a ninth found 205 was the identical
  // gap left unclosed): neither carries a response body per the HTTP
  // spec (RFC 9110 -- 205 "does not carry content" exactly like 204), so
  // there's nothing for the Cache-Control comparison below to actually be
  // checking *against* -- the same "nothing meaningful to compare"
  // reasoning already applied to a hard 4xx/5xx failure and a surviving
  // 3xx, just for a different reason. Named as a set, not two separate
  // !== checks, so a future no-body status doesn't need its own
  // independent discovery the way 205 just did.
  const NO_REPRESENTATION_STATUSES = new Set([204, 205]);
  const originOk =
    originStatus >= 200 && originStatus < 300 && !NO_REPRESENTATION_STATUSES.has(originStatus);
  const cdnOk = cdnStatus >= 200 && cdnStatus < 300 && !NO_REPRESENTATION_STATUSES.has(cdnStatus);
  if (!originOk) problems.push(`origin request failed: HTTP ${originStatus} (${originRequestUrl})`);
  if (!cdnOk) problems.push(`CDN request failed: HTTP ${cdnStatus} (${cdnRequestUrl})`);

  // If either leg failed outright, comparing headers can't mean anything
  // -- report the failure directly rather than letting two broken
  // responses compare as equal.
  if (!originOk || !cdnOk) {
    return { ok: false, problems, mismatches: [] };
  }

  // The same review round found that two otherwise-healthy 2xx statuses
  // were never actually required to be the *same* status -- origin
  // returning 200 (real content) and the CDN returning 206 (Partial
  // Content, implying byte-range serving the client never asked for) or
  // 201 would both individually pass the range check above, and then
  // compare as "ok" whenever their Cache-Control values happened to
  // match or were both absent. Comparing headers between two genuinely
  // different kinds of response proves nothing about whether the CDN
  // altered caching behavior for a given real response -- so the
  // statuses themselves must match before headers are compared at all.
  if (originStatus !== cdnStatus) {
    problems.push(
      `origin and CDN returned different statuses (origin: HTTP ${originStatus}, CDN: HTTP ${cdnStatus}) -- comparing headers between two different kinds of response isn't meaningful`,
    );
    return { ok: false, problems, mismatches: [] };
  }

  // Both legs' own *actual* destinations, not merely what was requested --
  // either side may redirect (e.g. a bare domain to www, or http to
  // https), and what matters is whether the two responses actually came
  // from two independent endpoints, not whether either matches the
  // literal URL this check happened to be pointed at.
  const originRequestHost = new URL(originRequestUrl).host;
  const originFinalHost = new URL(originFinalUrl).host;
  const cdnRequestHost = new URL(cdnRequestUrl).host;
  const cdnFinalHost = new URL(cdnFinalUrl).host;

  // A fifth review round found the original version of this guard only
  // ever checked one direction (a CDN URL redirecting through to origin's
  // destination) -- but the same problem exists in reverse: if origin's
  // own request redirects onto the CDN's host while the CDN request stays
  // put there, both responses again come from the same single endpoint
  // (the CDN, this time), and origin was never really exercised. Treated
  // symmetrically: flag any case where both legs converge on the same
  // final host UNLESS neither leg redirected to get there (a deliberate
  // same-host smoke test, where both request hosts already equalled that
  // host with no redirect involved).
  if (cdnFinalHost === originFinalHost) {
    const cdnRedirected = cdnRequestHost !== cdnFinalHost;
    const originRedirected = originRequestHost !== originFinalHost;
    if (cdnRedirected || originRedirected) {
      problems.push(
        `origin and CDN converged on the same final destination (${originFinalHost}) after at least one of them redirected there -- at least one leg never actually exercised its own distinct endpoint`,
      );
      return { ok: false, problems, mismatches: [] };
    }
  }

  const headerResult = compareCacheHeaders(originHeaders, cdnHeaders);
  if (!headerResult.ok) {
    problems.push("CDN does not preserve origin's freshness headers unchanged");
  }

  return { ok: problems.length === 0, problems, mismatches: headerResult.mismatches };
}

// Renders evaluateCdnCheck's result as a human-readable report --
// separated from the decision itself so the CLI wrapper's own tests (and
// any future caller) can assert on the structured result directly instead
// of parsing text back out of a message string.
export function formatCheckReport(url, result) {
  if (result.ok) return `OK: ${url} -- CDN preserves all origin freshness headers`;
  const lines = [
    ...result.problems.map((p) => `  ${p}`),
    ...result.mismatches.map(
      (m) => `  ${m.header}: origin="${m.origin ?? "(absent)"}" cdn="${m.cdn ?? "(absent)"}"`,
    ),
  ];
  return [`FAIL: ${url} -- CDN check failed`, ...lines].join("\n");
}
