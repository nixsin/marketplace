import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findDeployForCommit,
  classifyDeployReadiness,
  shouldStopPolling,
  shouldPurge,
} from "./render-deploy-status.mjs";

function deploy(status, commitSha) {
  return { id: `dep-${commitSha}`, status, commit: { id: commitSha } };
}

// --- findDeployForCommit ---

test("findDeployForCommit: finds the deploy matching the target commit, not just the first one", () => {
  const deploys = [deploy("live", "aaa111"), deploy("build_failed", "bbb222")];
  const found = findDeployForCommit(deploys, "bbb222");
  assert.equal(found.commit.id, "bbb222");
  assert.equal(found.status, "build_failed");
});

test("findDeployForCommit: returns null, not undefined or throwing, when no deploy matches yet", () => {
  const deploys = [deploy("live", "aaa111")];
  assert.equal(findDeployForCommit(deploys, "zzz999"), null);
});

test("findDeployForCommit: handles an empty deploys list (e.g. a brand new service)", () => {
  assert.equal(findDeployForCommit([], "aaa111"), null);
});

// --- classifyDeployReadiness ---

test("classifyDeployReadiness: no deploy yet is not_found, not pending -- these must stay distinguishable", () => {
  // not_found means Render's own trigger hasn't even registered this
  // commit as a deploy yet; pending means it has and is actively working.
  // Collapsing these would make it impossible to tell "waiting on Render
  // to start" apart from "waiting on Render to finish".
  assert.equal(classifyDeployReadiness(null), "not_found");
});

test("classifyDeployReadiness: live status is live", () => {
  assert.equal(classifyDeployReadiness(deploy("live", "aaa")), "live");
});

test("classifyDeployReadiness: every real in-progress status is pending", () => {
  for (const status of [
    "created",
    "queued",
    "build_in_progress",
    "update_in_progress",
    "pre_deploy_in_progress",
  ]) {
    assert.equal(classifyDeployReadiness(deploy(status, "aaa")), "pending", status);
  }
});

test("classifyDeployReadiness: every real terminal-failure status is failed", () => {
  for (const status of ["build_failed", "update_failed", "canceled", "pre_deploy_failed"]) {
    assert.equal(classifyDeployReadiness(deploy(status, "aaa")), "failed", status);
  }
});

test("classifyDeployReadiness: deactivated is its own state, not lumped into failed", () => {
  assert.equal(classifyDeployReadiness(deploy("deactivated", "aaa")), "superseded");
});

test("classifyDeployReadiness: an unrecognized future status fails safe to pending, not live or failed", () => {
  // If Render ever adds a new status value this doesn't know about yet,
  // the safe default is "keep waiting", not silently treating an unknown
  // state as either "safe to purge" or "give up".
  assert.equal(classifyDeployReadiness(deploy("some_new_status", "aaa")), "pending");
});

// --- shouldStopPolling ---

test("shouldStopPolling: true for live, failed, and superseded", () => {
  assert.equal(shouldStopPolling("live"), true);
  assert.equal(shouldStopPolling("failed"), true);
  assert.equal(shouldStopPolling("superseded"), true);
});

test("shouldStopPolling: false for not_found and pending", () => {
  assert.equal(shouldStopPolling("not_found"), false);
  assert.equal(shouldStopPolling("pending"), false);
});

// --- shouldPurge ---

test("shouldPurge: only true for live", () => {
  assert.equal(shouldPurge("live"), true);
  for (const readiness of ["not_found", "pending", "failed", "superseded"]) {
    assert.equal(shouldPurge(readiness), false, readiness);
  }
});
