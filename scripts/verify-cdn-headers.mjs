#!/usr/bin/env node
// Thin CLI wrapper around scripts/lib/cdn-header-check.mjs's pure
// comparison logic -- see that file for why this check exists (#78
// §1.2). Fetches the same path from an origin URL and a CDN-fronted URL,
// compares the caching-relevant headers, exits non-zero on a mismatch so
// this can run as a scheduled CI check (mirroring
// docker-scan-scheduled.yml's own "catch drift on a schedule, not just
// on push" pattern) once a real CDN endpoint exists.
//
// Not wired into any workflow yet -- #78 Part 1's own blocking
// prerequisite (a custom domain) isn't resolved, so there's no real CDN
// URL to point this at today. Usage, once there is one:
//   node scripts/verify-cdn-headers.mjs <origin-url> <cdn-url> [path...]

import { compareCacheHeaders, formatMismatchReport } from "./lib/cdn-header-check.mjs";

function headersToRecord(headers) {
  const record = {};
  for (const [key, value] of headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

async function checkPath(originBase, cdnBase, path) {
  const originUrl = new URL(path, originBase).toString();
  const cdnUrl = new URL(path, cdnBase).toString();

  const [originRes, cdnRes] = await Promise.all([
    fetch(originUrl, { redirect: "follow" }),
    fetch(cdnUrl, { redirect: "follow" }),
  ]);

  const result = compareCacheHeaders(
    headersToRecord(originRes.headers),
    headersToRecord(cdnRes.headers),
  );
  console.log(formatMismatchReport(cdnUrl, result));
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

  const results = await Promise.all(
    targetPaths.map((path) => checkPath(originBase, cdnBase, path)),
  );

  if (results.some((ok) => !ok)) {
    console.error("\nCDN header check FAILED -- see mismatches above.");
    process.exit(1);
  }
  console.log("\nAll paths OK.");
}

main().catch((error) => {
  console.error("verify-cdn-headers.mjs crashed:", error);
  process.exit(1);
});
