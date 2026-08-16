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

test("isStuck: action_required older than the threshold is stuck", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const createdAt = "2026-08-15T00:00:00Z"; // well over 24h earlier
  assert.equal(isStuck({ conclusion: "action_required", createdAt, nowEpoch: now }), true);
});

test("isStuck: action_required within the threshold is not stuck yet", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const createdAt = "2026-08-16T11:00:00Z"; // 1h earlier
  assert.equal(isStuck({ conclusion: "action_required", createdAt, nowEpoch: now }), false);
});

test("isStuck: exactly at the threshold boundary is not stuck (strictly greater-than)", () => {
  const now = 86400; // epoch seconds
  const createdAt = new Date(0).toISOString(); // epoch 0
  assert.equal(isStuck({ conclusion: "action_required", createdAt, nowEpoch: now }), false);
});

test("isStuck: one second past the threshold is stuck", () => {
  const now = 86401;
  const createdAt = new Date(0).toISOString();
  assert.equal(isStuck({ conclusion: "action_required", createdAt, nowEpoch: now }), true);
});

test("isStuck: any conclusion other than action_required is never stuck", () => {
  const now = Math.floor(Date.parse("2026-08-16T12:00:00Z") / 1000);
  const createdAt = "2026-08-01T00:00:00Z";
  assert.equal(isStuck({ conclusion: "success", createdAt, nowEpoch: now }), false);
  assert.equal(isStuck({ conclusion: "", createdAt, nowEpoch: now }), false);
});

test("isStuck: missing createdAt is never stuck, doesn't throw", () => {
  assert.equal(isStuck({ conclusion: "action_required", createdAt: "", nowEpoch: 100000 }), false);
});

test("decideStuckAction: failed lookup skips regardless of otherwise-stuck-shaped input", () => {
  assert.deepEqual(
    decideStuckAction({
      lookupOk: false,
      commentLookupOk: true,
      conclusion: "action_required",
      createdAt: "2020-01-01T00:00:00Z",
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
      conclusion: "action_required",
      createdAt: "2026-08-15T00:00:00Z",
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
      conclusion: "success",
      createdAt: "2026-08-16T00:00:00Z",
      nowEpoch: 9999999999,
      existingCommentId: "123",
    }),
    { action: "resolve", reason: "not-stuck" },
  );
});
