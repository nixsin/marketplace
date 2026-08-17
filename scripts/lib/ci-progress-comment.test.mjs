import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyJobDisplay,
  computeProgress,
  buildCommentBody,
  shouldStopPolling,
  decideStatusLine,
} from "./ci-progress-comment.mjs";

const TRACKED_NAMES = [
  "Detect changed paths",
  "Lint",
  "Web performance budget (Lighthouse)",
  "Docker image vulnerability scan",
];

// --- classifyJobDisplay ---

test("classifyJobDisplay: missing job is pending", () => {
  assert.equal(classifyJobDisplay(null), "pending");
});

test("classifyJobDisplay: in-progress job shows its status", () => {
  assert.equal(
    classifyJobDisplay({ status: "in_progress", conclusion: null }),
    "in_progress",
  );
});

test("classifyJobDisplay: completed success shows conclusion", () => {
  assert.equal(
    classifyJobDisplay({ status: "completed", conclusion: "success" }),
    "success",
  );
});

test("classifyJobDisplay: completed with null conclusion shows unknown", () => {
  assert.equal(
    classifyJobDisplay({ status: "completed", conclusion: null }),
    "unknown",
  );
});

// --- computeProgress ---
// The conclusion-classification bug ai-code-review caught on PR #66:
// an earlier version of hasFailure only checked conclusion === "failure",
// which left timed_out/action_required/stale/neutral/null jobs reported
// as part of a passing run. Every completed-but-not-ok conclusion below
// must set hasFailure, not just "failure" itself.

test("computeProgress: mid-run, only some jobs have appeared in the API yet", () => {
  const result = computeProgress({
    jobs: [
      { name: "Detect changed paths", status: "completed", conclusion: "success" },
      { name: "Lint", status: "in_progress", conclusion: null },
    ],
    trackedNames: TRACKED_NAMES,
  });
  assert.equal(result.done, false);
  assert.equal(result.hasFailure, false);
  assert.equal(result.hasCancelled, false);
  assert.match(result.table, /\| Detect changed paths \| success \|/);
  assert.match(result.table, /\| Lint \| in_progress \|/);
  assert.match(result.table, /\| Web performance budget \(Lighthouse\) \| pending \|/);
});

test("computeProgress: full clean run -- done, no failure, no cancellation", () => {
  const jobs = TRACKED_NAMES.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
  const result = computeProgress({ jobs, trackedNames: TRACKED_NAMES });
  assert.equal(result.done, true);
  assert.equal(result.hasFailure, false);
  assert.equal(result.hasCancelled, false);
});

test("computeProgress: skipped jobs count as done and ok, not a failure", () => {
  const jobs = TRACKED_NAMES.map((name) => ({
    name,
    status: "completed",
    conclusion: "skipped",
  }));
  const result = computeProgress({ jobs, trackedNames: TRACKED_NAMES });
  assert.equal(result.done, true);
  assert.equal(result.hasFailure, false);
});

test("computeProgress: a real failure is reported", () => {
  const jobs = TRACKED_NAMES.map((name) => ({
    name,
    status: "completed",
    conclusion: name === "Lint" ? "failure" : "success",
  }));
  const result = computeProgress({ jobs, trackedNames: TRACKED_NAMES });
  assert.equal(result.done, true);
  assert.equal(result.hasFailure, true);
  assert.equal(result.hasCancelled, false);
});

test("computeProgress: cancelled is reported separately, not counted as a failure", () => {
  const jobs = TRACKED_NAMES.map((name) => ({
    name,
    status: "completed",
    conclusion: name === "Docker image vulnerability scan" ? "cancelled" : "success",
  }));
  const result = computeProgress({ jobs, trackedNames: TRACKED_NAMES });
  assert.equal(result.done, true);
  assert.equal(result.hasFailure, false);
  assert.equal(result.hasCancelled, true);
});

for (const conclusion of ["timed_out", "action_required", "stale", "neutral"]) {
  test(`computeProgress: completed/${conclusion} counts as a failure`, () => {
    const jobs = TRACKED_NAMES.map((name) => ({
      name,
      status: "completed",
      conclusion: name === "Lint" ? conclusion : "success",
    }));
    const result = computeProgress({ jobs, trackedNames: TRACKED_NAMES });
    assert.equal(result.hasFailure, true);
    assert.equal(result.hasCancelled, false);
  });
}

test("computeProgress: completed with a null conclusion counts as a failure", () => {
  const jobs = TRACKED_NAMES.map((name) => ({
    name,
    status: "completed",
    conclusion: name === "Lint" ? null : "success",
  }));
  const result = computeProgress({ jobs, trackedNames: TRACKED_NAMES });
  assert.equal(result.hasFailure, true);
});

// --- buildCommentBody ---

test("buildCommentBody: includes marker, heading, table, and run link", () => {
  const body = buildCommentBody({
    marker: "<!-- ci-result-comment -->",
    heading: "🔄 CI running",
    note: "some note",
    table: "| Lint | success |",
    runUrl: "https://example.com/run/1",
  });
  assert.match(body, /^<!-- ci-result-comment -->\n/);
  assert.match(body, /🔄 CI running/);
  assert.match(body, /some note/);
  assert.match(body, /\| Lint \| success \|/);
  assert.match(body, /Run: https:\/\/example\.com\/run\/1$/);
});

// --- shouldStopPolling ---

test("shouldStopPolling: stops once done, regardless of iteration count", () => {
  assert.equal(
    shouldStopPolling({ iteration: 1, maxIterations: 90, done: true }),
    true,
  );
});

test("shouldStopPolling: stops once maxIterations reached, even if not done", () => {
  assert.equal(
    shouldStopPolling({ iteration: 90, maxIterations: 90, done: false }),
    true,
  );
});

test("shouldStopPolling: keeps polling when neither condition is met", () => {
  assert.equal(
    shouldStopPolling({ iteration: 5, maxIterations: 90, done: false }),
    false,
  );
});

// --- decideStatusLine ---

test("decideStatusLine: timed out takes priority over everything else", () => {
  assert.match(
    decideStatusLine({ timedOut: true, hasFailure: true, hasCancelled: true }),
    /Still waiting/,
  );
});

test("decideStatusLine: failure reported when not timed out", () => {
  assert.match(
    decideStatusLine({ timedOut: false, hasFailure: true, hasCancelled: false }),
    /checks failed/,
  );
});

test("decideStatusLine: cancelled reported when no failure", () => {
  assert.match(
    decideStatusLine({ timedOut: false, hasFailure: false, hasCancelled: true }),
    /cancelled/,
  );
});

test("decideStatusLine: all clear reports success", () => {
  assert.match(
    decideStatusLine({ timedOut: false, hasFailure: false, hasCancelled: false }),
    /All checks passed/,
  );
});
