import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideEnumeration,
  decideConflictAction,
  decideStuckAction,
  isStuck,
} from "./pr-reconciliation.mjs";

// --- decideEnumeration ---

test("decideEnumeration: failed lookup fails, regardless of prNumbers", () => {
  assert.deepEqual(decideEnumeration({ lookupOk: false, prNumbers: [] }), {
    action: "fail",
    reason: "enumeration-lookup-failed",
  });
});

test("decideEnumeration: successful lookup with no open PRs is a real no-op, not a failure", () => {
  assert.deepEqual(decideEnumeration({ lookupOk: true, prNumbers: [] }), {
    action: "no-op",
    reason: "no-open-prs",
  });
});

test("decideEnumeration: successful lookup with open PRs proceeds", () => {
  assert.deepEqual(decideEnumeration({ lookupOk: true, prNumbers: [21, 22] }), {
    action: "proceed",
    reason: "has-open-prs",
  });
});

// --- decideConflictAction ---

test("decideConflictAction: failed status lookup skips, even if DIRTY-shaped input leaks through", () => {
  assert.deepEqual(
    decideConflictAction({
      lookupOk: false,
      commentLookupOk: true,
      mergeStatus: "DIRTY",
      existingCommentId: "123",
    }),
    { action: "skip", reason: "lookup-failed" },
  );
});

test("decideConflictAction: failed comment lookup skips even with a confirmed DIRTY status", () => {
  assert.deepEqual(
    decideConflictAction({
      lookupOk: true,
      commentLookupOk: false,
      mergeStatus: "DIRTY",
      existingCommentId: "",
    }),
    { action: "skip", reason: "lookup-failed" },
  );
});

test("decideConflictAction: DIRTY flags", () => {
  assert.deepEqual(
    decideConflictAction({
      lookupOk: true,
      commentLookupOk: true,
      mergeStatus: "DIRTY",
      existingCommentId: "",
    }),
    { action: "flag", reason: "dirty" },
  );
});

test("decideConflictAction: UNKNOWN skips, never resolves — a real, documented GraphQL enum value meaning 'still computing,' not confirmation of a clean state", () => {
  assert.deepEqual(
    decideConflictAction({
      lookupOk: true,
      commentLookupOk: true,
      mergeStatus: "UNKNOWN",
      existingCommentId: "123",
    }),
    { action: "skip", reason: "unknown" },
  );
});

test("decideConflictAction: confirmed clean with an existing flag resolves", () => {
  assert.deepEqual(
    decideConflictAction({
      lookupOk: true,
      commentLookupOk: true,
      mergeStatus: "CLEAN",
      existingCommentId: "123",
    }),
    { action: "resolve", reason: "clean" },
  );
});

test("decideConflictAction: confirmed clean with no existing flag does nothing", () => {
  assert.deepEqual(
    decideConflictAction({
      lookupOk: true,
      commentLookupOk: true,
      mergeStatus: "CLEAN",
      existingCommentId: "",
    }),
    { action: "skip", reason: "clean-no-existing-flag" },
  );
});

// --- isStuck / decideStuckAction ---
// `runs` is every workflow run for the PR's current head commit (across
// every workflow, not just the single most recent) — this repo genuinely
// has two that trigger per push (CI and CodeQL, confirmed live), and the
// bug this replaced only ever checked the single most recent one.

test("isStuck: a single action_required run older than the threshold is stuck", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const runs = [{ conclusion: "action_required", createdAt: "2026-08-15T00:00:00Z" }]; // well over 24h earlier
  assert.equal(isStuck({ runs, nowEpoch: now }), true);
});

test("isStuck: action_required within the threshold is not stuck yet", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const runs = [{ conclusion: "action_required", createdAt: "2026-08-16T11:00:00Z" }]; // 1h earlier
  assert.equal(isStuck({ runs, nowEpoch: now }), false);
});

test("isStuck: exactly at the threshold boundary is not stuck (strictly greater-than)", () => {
  const runs = [{ conclusion: "action_required", createdAt: new Date(0).toISOString() }];
  assert.equal(isStuck({ runs, nowEpoch: 86400 }), false);
});

test("isStuck: one second past the threshold is stuck", () => {
  const runs = [{ conclusion: "action_required", createdAt: new Date(0).toISOString() }];
  assert.equal(isStuck({ runs, nowEpoch: 86401 }), true);
});

// The exact scenario a live review caught: multiple workflows for the
// same revision, one already resolved, one still stuck. Checking only
// the most recent run (the prior implementation) could pick either one
// arbitrarily and miss the real stuck one — checking all of them can't.
test("isStuck: one successful run and one stuck run for the same revision — still stuck", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const runs = [
    { conclusion: "success", createdAt: "2026-08-16T11:59:00Z" }, // CodeQL, just ran fine
    { conclusion: "action_required", createdAt: "2026-08-15T00:00:00Z" }, // CI, stuck over 24h
  ];
  assert.equal(isStuck({ runs, nowEpoch: now }), true);
});

test("isStuck: multiple runs, none action_required, is not stuck", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const runs = [
    { conclusion: "success", createdAt: "2026-08-16T11:59:00Z" },
    { conclusion: "success", createdAt: "2026-08-16T11:58:00Z" },
  ];
  assert.equal(isStuck({ runs, nowEpoch: now }), false);
});

test("isStuck: empty/missing runs is never stuck, doesn't throw", () => {
  assert.equal(isStuck({ runs: [], nowEpoch: 100000 }), false);
  assert.equal(isStuck({ runs: undefined, nowEpoch: 100000 }), false);
});

test("isStuck: a run missing createdAt is never stuck on its own, doesn't throw", () => {
  const runs = [{ conclusion: "action_required", createdAt: "" }];
  assert.equal(isStuck({ runs, nowEpoch: 100000 }), false);
});

test("decideStuckAction: failed lookup skips regardless of otherwise-stuck-shaped input", () => {
  assert.deepEqual(
    decideStuckAction({
      lookupOk: false,
      commentLookupOk: true,
      runs: [{ conclusion: "action_required", createdAt: "2020-01-01T00:00:00Z" }],
      nowEpoch: 9999999999,
      existingCommentId: "",
    }),
    { action: "skip", reason: "lookup-failed" },
  );
});

test("decideStuckAction: confirmed stuck flags", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  assert.deepEqual(
    decideStuckAction({
      lookupOk: true,
      commentLookupOk: true,
      runs: [{ conclusion: "action_required", createdAt: "2026-08-15T00:00:00Z" }],
      nowEpoch: now,
      existingCommentId: "",
    }),
    { action: "flag", reason: "stuck" },
  );
});

test("decideStuckAction: confirmed not stuck with an existing flag resolves", () => {
  assert.deepEqual(
    decideStuckAction({
      lookupOk: true,
      commentLookupOk: true,
      runs: [{ conclusion: "success", createdAt: "2026-08-16T00:00:00Z" }],
      nowEpoch: 9999999999,
      existingCommentId: "123",
    }),
    { action: "resolve", reason: "not-stuck" },
  );
});
