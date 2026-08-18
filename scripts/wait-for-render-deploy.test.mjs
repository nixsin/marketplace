import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDeploys, waitForDeploy } from "./wait-for-render-deploy.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function deployItem(status, commitSha, cursor) {
  return { deploy: { id: `dep-${commitSha}`, status, commit: { id: commitSha } }, cursor };
}

// --- fetchDeploys ---

test("fetchDeploys: a single short page (fewer than the limit) is the whole result, no extra request", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return jsonResponse([deployItem("live", "aaa", "cursor-a")]);
  };
  const deploys = await fetchDeploys("svc-1", "key", fetchImpl);
  assert.equal(deploys.length, 1);
  assert.equal(callCount, 1);
});

test("fetchDeploys: a real AI review found this exact gap -- a target commit outside the first page must still be found via pagination", async () => {
  // First page is a full page (20 items) of unrelated commits; the
  // target only shows up on page 2. The original version of this script
  // fetched exactly one page and would have reported "not_found" forever
  // for this commit.
  const page1 = Array.from({ length: 20 }, (_, i) => deployItem("live", `old-${i}`, `cursor-${i}`));
  const page2 = [deployItem("live", "target-commit", "cursor-last")];
  let requestedCursors = [];
  const fetchImpl = async (url) => {
    const cursor = new URL(url).searchParams.get("cursor");
    requestedCursors.push(cursor);
    return jsonResponse(cursor === "cursor-19" ? page2 : page1);
  };
  const deploys = await fetchDeploys("svc-1", "key", fetchImpl);
  assert.ok(deploys.some((d) => d.commit.id === "target-commit"));
  // Second request must use the *last* item's cursor from the first page.
  assert.equal(requestedCursors[1], "cursor-19");
});

test("fetchDeploys: stops at MAX_PAGES even if every page happens to come back full, rather than paginating forever", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    // Always return a full page -- an adversarial/pathological case that
    // would paginate forever without a hard cap.
    return jsonResponse(
      Array.from({ length: 20 }, (_, i) => deployItem("live", `c-${callCount}-${i}`, `cur-${callCount}-${i}`)),
    );
  };
  await fetchDeploys("svc-1", "key", fetchImpl);
  assert.equal(callCount, 5); // MAX_PAGES
});

test("fetchDeploys: a non-ok API response throws with the status and body, not a silent empty result", async () => {
  const fetchImpl = async () => jsonResponse({ message: "invalid service id" }, 404);
  await assert.rejects(
    () => fetchDeploys("bad-svc", "key", fetchImpl),
    /Render API returned 404/,
  );
});

// --- waitForDeploy ---

function instantSleep() {
  return async () => {}; // no real delay, for fast tests
}

test("waitForDeploy: stops immediately once the target commit is live, and says purge is safe", async () => {
  const fetchImpl = async () => jsonResponse([deployItem("live", "aaa", "c1")]);
  const attempts = [];
  const result = await waitForDeploy("svc-1", "aaa", "key", {
    fetchImpl,
    sleepImpl: instantSleep(),
    onAttempt: (info) => attempts.push(info.readiness),
  });
  assert.equal(result.readiness, "live");
  assert.equal(result.shouldPurge, true);
  assert.deepEqual(attempts, ["live"]);
});

test("waitForDeploy: a build failure stops polling and does not recommend purging", async () => {
  const fetchImpl = async () => jsonResponse([deployItem("build_failed", "aaa", "c1")]);
  const result = await waitForDeploy("svc-1", "aaa", "key", {
    fetchImpl,
    sleepImpl: instantSleep(),
  });
  assert.equal(result.readiness, "failed");
  assert.equal(result.shouldPurge, false);
});

test("waitForDeploy: keeps polling through pending states, then resolves once live", async () => {
  let call = 0;
  const statuses = ["queued", "build_in_progress", "update_in_progress", "live"];
  const fetchImpl = async () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call++;
    return jsonResponse([deployItem(status, "aaa", "c1")]);
  };
  const attempts = [];
  const result = await waitForDeploy("svc-1", "aaa", "key", {
    fetchImpl,
    sleepImpl: instantSleep(),
    onAttempt: (info) => attempts.push(info.readiness),
  });
  assert.equal(result.readiness, "live");
  assert.deepEqual(attempts, ["pending", "pending", "pending", "live"]);
});

test("waitForDeploy: exhausting maxAttempts on a commit that never resolves times out rather than looping forever", async () => {
  const fetchImpl = async () => jsonResponse([]); // commit never appears
  const result = await waitForDeploy("svc-1", "never-shows-up", "key", {
    fetchImpl,
    sleepImpl: instantSleep(),
    maxAttempts: 3,
  });
  assert.equal(result.readiness, "timed_out");
  assert.equal(result.shouldPurge, false);
});

test("waitForDeploy: does not sleep after the final attempt (no wasted delay once maxAttempts is reached)", async () => {
  let sleepCount = 0;
  const fetchImpl = async () => jsonResponse([]);
  await waitForDeploy("svc-1", "never-shows-up", "key", {
    fetchImpl,
    sleepImpl: async () => {
      sleepCount++;
    },
    maxAttempts: 3,
  });
  assert.equal(sleepCount, 2); // slept between attempts 1->2 and 2->3, not after 3
});
