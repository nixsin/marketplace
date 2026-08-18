import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareCacheHeaders,
  evaluateCdnCheck,
  formatCheckReport,
} from "./cdn-header-check.mjs";

// --- compareCacheHeaders ---

test("compareCacheHeaders: identical cache-control is ok", () => {
  const result = compareCacheHeaders(
    { "cache-control": "public, max-age=0, must-revalidate" },
    { "cache-control": "public, max-age=0, must-revalidate" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test("compareCacheHeaders: CDN overriding must-revalidate away is a mismatch", () => {
  // The exact failure mode #78 §1.2 exists to catch -- a CDN dashboard
  // default silently caching "everything" regardless of origin intent.
  const result = compareCacheHeaders(
    { "cache-control": "public, max-age=0, must-revalidate" },
    { "cache-control": "public, max-age=86400" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].header, "cache-control");
  assert.equal(result.mismatches[0].origin, "public, max-age=0, must-revalidate");
  assert.equal(result.mismatches[0].cdn, "public, max-age=86400");
});

test("compareCacheHeaders: CDN stripping the header entirely is a mismatch, not silently ok", () => {
  const result = compareCacheHeaders(
    { "cache-control": "public, max-age=31536000, immutable" },
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.mismatches[0].cdn, undefined);
});

test("compareCacheHeaders: origin never setting cache-control at all is still comparable (both absent, ok)", () => {
  const result = compareCacheHeaders({}, {});
  assert.equal(result.ok, true);
});

test("compareCacheHeaders: is case-sensitive on header *values*, not just presence -- a CDN normalizing directive order counts as a real mismatch", () => {
  // Deliberately not "smart" about semantically-equivalent reorderings --
  // a CDN that rewrites the header at all, even to something equivalent,
  // is doing something to it, which is exactly what this check exists to
  // surface rather than paper over.
  const result = compareCacheHeaders(
    { "cache-control": "max-age=0, must-revalidate, public" },
    { "cache-control": "public, max-age=0, must-revalidate" },
  );
  assert.equal(result.ok, false);
});

// --- evaluateCdnCheck ---

const OK_INPUT = {
  originRequestUrl: "https://origin.example.com/en",
  originFinalUrl: "https://origin.example.com/en",
  originStatus: 200,
  originHeaders: { "cache-control": "public, max-age=0, must-revalidate" },
  cdnRequestUrl: "https://cdn.example.com/en",
  cdnFinalUrl: "https://cdn.example.com/en",
  cdnStatus: 200,
  cdnHeaders: { "cache-control": "public, max-age=0, must-revalidate" },
};

test("evaluateCdnCheck: matching, healthy responses are ok", () => {
  const result = evaluateCdnCheck(OK_INPUT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("evaluateCdnCheck: a real AI review found this exact gap -- two failing responses must not compare as ok just because their (absent) headers match", () => {
  const result = evaluateCdnCheck({
    ...OK_INPUT,
    originStatus: 500,
    originHeaders: {},
    cdnStatus: 500,
    cdnHeaders: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /origin request failed: HTTP 500/);
  assert.match(result.problems.join(" "), /CDN request failed: HTTP 500/);
  // Header comparison must not even run once either leg failed -- there's
  // nothing meaningful to compare.
  assert.deepEqual(result.mismatches, []);
});

test("evaluateCdnCheck: origin failing alone is reported, not masked by a healthy CDN response", () => {
  const result = evaluateCdnCheck({ ...OK_INPUT, originStatus: 404, originHeaders: {} });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /origin request failed: HTTP 404/);
});

test("evaluateCdnCheck: CDN failing alone is reported, not masked by a healthy origin response", () => {
  const result = evaluateCdnCheck({ ...OK_INPUT, cdnStatus: 502, cdnHeaders: {} });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /CDN request failed: HTTP 502/);
});

test("evaluateCdnCheck: a redirect status code alone (3xx) is treated as ok -- fetch's redirect:'follow' already resolved it, cdnStatus here is the final response's own status", () => {
  const result = evaluateCdnCheck({ ...OK_INPUT, cdnStatus: 304, originStatus: 304 });
  assert.equal(result.ok, true);
});

test("evaluateCdnCheck: a CDN URL that redirects straight through to the origin's requested host never actually exercised the CDN -- a real gap a live AI review found", () => {
  const result = evaluateCdnCheck({
    ...OK_INPUT,
    cdnRequestUrl: "https://cdn.example.com/en",
    cdnFinalUrl: "https://origin.example.com/en", // followed a redirect back to origin
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /redirected straight through to origin's own destination/);
});

test("evaluateCdnCheck: a CDN redirecting to origin's OWN real destination is caught even when origin itself also redirects -- the follow-up gap a second review round found", () => {
  // origin.example.com redirects to app.example.com (a legitimate,
  // unrelated redirect -- e.g. a bare domain to www, or http to https).
  // The CDN bypasses itself by also landing on app.example.com. Comparing
  // against origin's merely-*requested* host (origin.example.com) would
  // miss this, since app.example.com never equals origin.example.com --
  // only comparing against origin's own *final* destination catches it.
  const result = evaluateCdnCheck({
    ...OK_INPUT,
    originRequestUrl: "https://origin.example.com/en",
    originFinalUrl: "https://app.example.com/en",
    cdnRequestUrl: "https://cdn.example.com/en",
    cdnFinalUrl: "https://app.example.com/en",
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /redirected straight through to origin's own destination/);
});

test("evaluateCdnCheck: the CDN and origin legitimately being the same host (e.g. local smoke-testing with one URL for both) is NOT flagged -- only an actual redirect-to-origin is", () => {
  // Distinguishes "I deliberately pointed both args at the same place to
  // sanity-check the tool itself" from "the CDN silently bounced to
  // origin" -- the former only looks suspicious if cdnRequestHost already
  // differed from originFinalHost before any redirect happened.
  const result = evaluateCdnCheck({
    ...OK_INPUT,
    originRequestUrl: "https://same-host.example.com/en",
    originFinalUrl: "https://same-host.example.com/en",
    cdnRequestUrl: "https://same-host.example.com/en",
    cdnFinalUrl: "https://same-host.example.com/en",
  });
  assert.equal(result.ok, true);
});

test("evaluateCdnCheck: header mismatch on otherwise-healthy responses is still caught", () => {
  const result = evaluateCdnCheck({
    ...OK_INPUT,
    cdnHeaders: { "cache-control": "public, max-age=86400" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
});

// --- formatCheckReport ---

test("formatCheckReport: ok result reads as a clean pass", () => {
  const report = formatCheckReport("https://example.com/en", { ok: true, problems: [], mismatches: [] });
  assert.match(report, /^OK:/);
  assert.match(report, /example\.com\/en/);
});

test("formatCheckReport: a status-code problem is rendered even with no header mismatches", () => {
  const report = formatCheckReport("https://example.com/en", {
    ok: false,
    problems: ["origin request failed: HTTP 500 (https://example.com/en)"],
    mismatches: [],
  });
  assert.match(report, /^FAIL:/);
  assert.match(report, /HTTP 500/);
});

test("formatCheckReport: an absent header on one side renders as explicitly absent, not blank/undefined", () => {
  const report = formatCheckReport("https://example.com/en", {
    ok: false,
    problems: [],
    mismatches: [{ header: "cache-control", origin: "max-age=0", cdn: undefined }],
  });
  assert.match(report, /\(absent\)/);
  assert.doesNotMatch(report, /undefined/);
});
