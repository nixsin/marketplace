#!/usr/bin/env node
// Thin CLI wrapper around scripts/lib/cdn-header-check.mjs's pure
// evaluateCdnCheck logic -- see that file for why this check exists and
// what it does/doesn't catch (#78 §1.2). Fetches the same path from an
// origin URL and a CDN-fronted URL, evaluates the result, exits non-zero
// on any problem so this can run as a scheduled CI check (mirroring
// docker-scan-scheduled.yml's own "catch drift on a schedule, not just on
// push" pattern) once a real CDN endpoint exists.
//
// Not wired into any workflow yet -- #78 Part 1's own blocking
// prerequisite (a custom domain) isn't resolved, so there's no real CDN
// URL to point this at today. Usage, once there is one:
//   node scripts/verify-cdn-headers.mjs <origin-url> <cdn-url> [path...]

import { evaluateCdnCheck, formatCheckReport } from "./lib/cdn-header-check.mjs";

function headersToRecord(headers) {
  const record = {};
  for (const [key, value] of headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

// fetchImpl is injectable so tests can substitute a stub instead of
// making real network calls -- a real AI review flagged that the
// original version had no test coverage of this wrapper's own logic
// (status handling, redirect detection, URL construction) at all.
export async function checkPath(originBase, cdnBase, path, fetchImpl = fetch) {
  const originRequestUrl = new URL(path, originBase).toString();
  const cdnRequestUrl = new URL(path, cdnBase).toString();

  const [originRes, cdnRes] = await Promise.all([
    fetchImpl(originRequestUrl, { redirect: "follow" }),
    fetchImpl(cdnRequestUrl, { redirect: "follow" }),
  ]);

  const result = evaluateCdnCheck({
    originRequestUrl,
    // res.url is the *final* URL after any redirect origin itself made --
    // a second review round caught that comparing the CDN's final host
    // against origin's merely-*requested* host misses the case where
    // origin also redirects to its own real destination. Falls back to
    // the requested URL only if a stub/fixture omits .url (real fetch()
    // always sets it).
    originFinalUrl: originRes.url || originRequestUrl,
    originStatus: originRes.status,
    originHeaders: headersToRecord(originRes.headers),
    cdnRequestUrl,
    cdnFinalUrl: cdnRes.url || cdnRequestUrl,
    cdnStatus: cdnRes.status,
    cdnHeaders: headersToRecord(cdnRes.headers),
  });
  console.log(formatCheckReport(cdnRequestUrl, result));
  return result.ok;
}

async function main() {
  const [originBase, cdnBase, ...paths] = process.argv.slice(2);
  if (!originBase || !cdnBase) {
    console.error(
      "Usage: node scripts/verify-cdn-headers.mjs <origin-url> <cdn-url> [path...]",
    );
    process.exit(2);
  }
  const targetPaths = paths.length > 0 ? paths : ["/en"];

  const results = await Promise.all(targetPaths.map((path) => checkPath(originBase, cdnBase, path)));

  if (results.some((ok) => !ok)) {
    console.error("\nCDN header check FAILED -- see problems above.");
    process.exit(1);
  }
  console.log("\nAll paths OK.");
}

// Only run main() when executed directly (node scripts/verify-cdn-headers.mjs
// ...), not when imported by the test file for checkPath's own coverage.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("verify-cdn-headers.mjs crashed:", error);
    process.exit(1);
  });
}
