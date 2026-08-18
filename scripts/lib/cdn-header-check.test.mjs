import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCacheHeaders, formatMismatchReport } from "./cdn-header-check.mjs";

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

// --- formatMismatchReport ---

test("formatMismatchReport: ok result reads as a clean pass", () => {
  const report = formatMismatchReport("https://example.com/en", { ok: true, mismatches: [] });
  assert.match(report, /^OK:/);
  assert.match(report, /example\.com\/en/);
});

test("formatMismatchReport: failing result names the header and both values", () => {
  const report = formatMismatchReport("https://example.com/en", {
    ok: false,
    mismatches: [{ header: "cache-control", origin: "max-age=0", cdn: "max-age=86400" }],
  });
  assert.match(report, /^FAIL:/);
  assert.match(report, /cache-control/);
  assert.match(report, /max-age=0/);
  assert.match(report, /max-age=86400/);
});

test("formatMismatchReport: an absent header on one side renders as explicitly absent, not blank/undefined", () => {
  const report = formatMismatchReport("https://example.com/en", {
    ok: false,
    mismatches: [{ header: "cache-control", origin: "max-age=0", cdn: undefined }],
  });
  assert.match(report, /\(absent\)/);
  assert.doesNotMatch(report, /undefined/);
});
