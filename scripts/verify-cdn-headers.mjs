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

// A fifth review round found checkPath() had no timeout at all -- a
// stalled origin or CDN response would hang the Promise.all() below
// indefinitely, contradicting this file's own comments about running as
// a bounded, scheduled CI check. Mirrors wait-for-render-deploy.mjs's
// timeout pattern. Only wraps the fetchImpl() call itself, not a
// subsequent body read -- checkPath() only ever reads .status/.url/
// .headers, all available as soon as the response resolves, never
// .text()/.json(), so there's no streaming-body gap to protect against
// the way wait-for-render-deploy.mjs's own fetchPageWithTimeout needed to
// (see that file's round-3 fix). Revisit if this ever starts consuming a
// response body.
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(fetchImpl, url, options, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function headersToRecord(headers) {
  const record = {};
  for (const [key, value] of headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

// A sixth review round found that `new URL(path, base)` ignores `base`
// entirely when `path` is itself absolute (e.g. "https://evil.example.com/en")
// or protocol-relative ("//evil.example.com/en") -- per the WHATWG URL
// spec, either form replaces the base outright. Combined with
// cdn-header-check.mjs's own round-5 fix (which deliberately permits
// identical final hosts when *neither* leg redirected, for the legitimate
// same-host smoke-test case), a hijacked `path` argument would send both
// requests to the same unrelated host with no redirect involved on either
// side -- exactly the "neither redirected" case that guard is designed to
// let through -- so a matching response would report OK without ever
// exercising the configured origin or CDN. `path` is always CLI input
// (see main() below), so this validates it rather than trusting it.
function isSafeRelativePath(path) {
  if (path.startsWith("//")) return false; // protocol-relative -- overrides the host
  try {
    new URL(path); // succeeds only if `path` is already a standalone absolute URL
    return false;
  } catch {
    return true; // a genuine relative path throws when parsed with no base
  }
}

// fetchImpl is injectable so tests can substitute a stub instead of
// making real network calls -- a real AI review flagged that the
// original version had no test coverage of this wrapper's own logic
// (status handling, redirect detection, URL construction) at all.
// requestTimeoutMs is its own parameter for the same reason
// wait-for-render-deploy.mjs's equivalent is -- tests use a short timeout
// instead of waiting 30 real seconds to prove the abort actually fires.
export async function checkPath(
  originBase,
  cdnBase,
  path,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
) {
  if (!isSafeRelativePath(path)) {
    throw new Error(
      `checkPath: "${path}" is not a safe relative path -- an absolute or protocol-relative path would override the configured origin/CDN base entirely, silently skipping the check`,
    );
  }

  const originRequestUrl = new URL(path, originBase).toString();
  const cdnRequestUrl = new URL(path, cdnBase).toString();

  const [originRes, cdnRes] = await Promise.all([
    fetchWithTimeout(fetchImpl, originRequestUrl, { redirect: "follow" }, requestTimeoutMs),
    fetchWithTimeout(fetchImpl, cdnRequestUrl, { redirect: "follow" }, requestTimeoutMs),
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
