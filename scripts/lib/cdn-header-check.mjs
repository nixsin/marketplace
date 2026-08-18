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

// Full decision for one checked path, covering the two real gaps a live
// AI review found in the original header-only version:
//
// 1. Comparing headers is meaningless if either request itself failed --
//    two error responses can trivially carry the same (absent)
//    Cache-Control and compare as "ok", silently passing a check that
//    never actually exercised anything. Both status codes are checked
//    directly, before headers are ever compared.
// 2. A CDN URL that redirects straight through to the origin host proves
//    nothing about the CDN's own behavior -- fetch()'s `redirect: "follow"`
//    makes this invisible unless the *final* URL is checked against where
//    the request was actually sent.
//
// All inputs are plain values (no Response/Headers objects) so this stays
// a pure function the CLI wrapper's fetch results get normalized into --
// see verify-cdn-headers.mjs.
export function evaluateCdnCheck({
  originUrl,
  originStatus,
  originHeaders,
  cdnRequestUrl,
  cdnFinalUrl,
  cdnStatus,
  cdnHeaders,
}) {
  const problems = [];

  const originOk = originStatus >= 200 && originStatus < 400;
  const cdnOk = cdnStatus >= 200 && cdnStatus < 400;
  if (!originOk) problems.push(`origin request failed: HTTP ${originStatus} (${originUrl})`);
  if (!cdnOk) problems.push(`CDN request failed: HTTP ${cdnStatus} (${cdnRequestUrl})`);

  // If either leg failed outright, comparing headers can't mean anything
  // -- report the failure directly rather than letting two broken
  // responses compare as equal.
  if (!originOk || !cdnOk) {
    return { ok: false, problems, mismatches: [] };
  }

  const originHost = new URL(originUrl).host;
  const cdnRequestHost = new URL(cdnRequestUrl).host;
  const cdnFinalHost = new URL(cdnFinalUrl).host;
  if (cdnFinalHost === originHost && cdnRequestHost !== originHost) {
    problems.push(
      `CDN URL (${cdnRequestUrl}) redirected straight through to the origin host (${originHost}) -- this never actually exercised the CDN`,
    );
    return { ok: false, problems, mismatches: [] };
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
