// Pure logic behind the synthetic CDN-vs-origin header check that #78 §1.2
// calls for: "the CDN must respect origin Cache-Control, never override
// it." A common CDN default is "cache everything regardless of origin
// headers" -- that silently defeats must-revalidate for every layer behind
// it while the original Cache-Control header still passes through
// unchanged, so a dashboard misconfiguration looks fine from the browser's
// side right up until it serves someone stale data. This makes that a test
// failure instead of a user complaint.
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

// Renders compareCacheHeaders's result as a human-readable report --
// separated from the comparison itself so the CLI wrapper's own tests
// (and any future caller) can assert on the mismatch data directly
// instead of parsing text back out of a message string.
export function formatMismatchReport(url, result) {
  if (result.ok) return `OK: ${url} -- CDN preserves all origin freshness headers`;
  const lines = result.mismatches.map(
    (m) => `  ${m.header}: origin="${m.origin ?? "(absent)"}" cdn="${m.cdn ?? "(absent)"}"`,
  );
  return [`FAIL: ${url} -- CDN does not match origin`, ...lines].join("\n");
}
