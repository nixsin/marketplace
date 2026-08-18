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

// A fake, manually-advanced clock -- lets tests simulate wall-clock time
// passing (across sleeps or simulated request durations) without any real
// waiting, so deadline-related behavior can be asserted deterministically
// and fast.
function makeFakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
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

test("fetchDeploys: a request that never resolves is aborted after requestTimeoutMs, not left to hang forever -- a real AI review found MAX_ATTEMPTS's own 'hard bound' comment was false without this", () => {
  // A real fetch() rejects with an AbortError once its signal fires --
  // this stub reacts the same way, rather than actually never resolving,
  // so the test itself doesn't hang if the timeout mechanism is broken.
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
      // Deliberately never calls resolve() on its own -- simulates a
      // genuinely stalled request with no server-side timeout of its own.
    });
  return assert.rejects(
    () => fetchDeploys("svc-1", "key", fetchImpl, 10), // 10ms timeout, not the real 30s
    /aborted/i,
  );
});

test("fetchDeploys: a response whose headers arrive but whose BODY never finishes is also aborted, not left to hang -- a third review round found the timeout was cleared before the body was even read", () => {
  // fetch() itself can resolve as soon as headers are in, while the body
  // is still streaming -- a stub that resolves fetchImpl() quickly but
  // whose .json() hangs forever (unless the signal fires) reproduces
  // exactly that gap. Per the real Fetch spec, aborting a request's
  // signal cancels its response body stream too, not just the initial
  // connection -- this stub's .json() mirrors that by listening to the
  // same signal it was handed.
  const fetchImpl = async (url, options) => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
        // Never resolves on its own -- the headers "arrived" (this
        // function was called), but the body read itself stalls.
      }),
  });
  return assert.rejects(
    () => fetchDeploys("svc-1", "key", fetchImpl, 10),
    /aborted/i,
  );
});

test("fetchDeploys: a single request's own timeout is clamped to the remaining overall deadline, not the full requestTimeoutMs, when the deadline is closer -- a fourth review round found MAX_ATTEMPTS * POLL_INTERVAL_MS was never a real bound since each attempt's own fetchDeploys() could still take far longer via its per-page requestTimeoutMs", async () => {
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
      // Never resolves on its own -- if the deadline weren't actually
      // clamping the request's own timeout, this would hang for the full
      // 30s requestTimeoutMs instead of the ~20ms deadline below.
    });
  const deadline = Date.now() + 20;
  const start = Date.now();
  await assert.rejects(
    () => fetchDeploys("svc-1", "key", fetchImpl, 30_000, deadline, Date.now),
    /aborted/i,
  );
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 5000,
    `expected the request to abort well under the full 30s timeout (clamped to ~20ms), took ${elapsed}ms`,
  );
});

test("fetchDeploys: stops paginating early once the overall deadline is hit mid-pagination, returning what it already has rather than issuing one more doomed request", async () => {
  const clock = makeFakeClock();
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    clock.advance(60_000); // simulate each page taking 60s
    // Full pages, so without the deadline check this would keep
    // paginating up to MAX_PAGES.
    return jsonResponse(
      Array.from({ length: 20 }, (_, i) => deployItem("live", `c-${callCount}-${i}`, `cur-${callCount}-${i}`)),
    );
  };
  const deadline = 50_000; // less than two simulated page-fetches' worth of time
  const deploys = await fetchDeploys("svc-1", "key", fetchImpl, 30_000, deadline, clock.now);
  assert.equal(callCount, 1); // only the first page's request was ever made
  assert.equal(deploys.length, 20); // the partial result from that one page, not discarded
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

test("waitForDeploy: an overall maxRuntimeMs deadline stops polling even if maxAttempts hasn't been reached -- a fourth review round found MAX_ATTEMPTS * POLL_INTERVAL_MS alone (the original '10 minutes -- a hard bound' claim) was never a real bound once fetchDeploys's own per-page retries are counted", async () => {
  const clock = makeFakeClock();
  const fetchImpl = async () => jsonResponse([]); // commit never appears
  const attempts = [];
  const result = await waitForDeploy("svc-1", "never-shows-up", "key", {
    fetchImpl,
    sleepImpl: async (ms) => {
      clock.advance(ms);
    },
    nowImpl: clock.now,
    maxAttempts: 1000, // deliberately far higher than the deadline should ever let it reach
    pollIntervalMs: 10_000,
    maxRuntimeMs: 100_000, // 100s of simulated time -- should allow exactly 10 attempts (10s apart) before the deadline stops it
    onAttempt: (info) => attempts.push(info.readiness),
  });
  assert.equal(result.readiness, "timed_out");
  assert.equal(attempts.length, 10);
});

test("waitForDeploy: reaching the overall deadline mid-request returns a clean timed_out result instead of crashing -- a fifth review round found the round-4 deadline clamp let the resulting abort propagate as an uncaught error", async () => {
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
      // Never resolves on its own -- simulates a request still in flight
      // when the overall deadline expires.
    });
  // A first version of this test raced real wall-clock time (a 20ms
  // maxRuntimeMs against a real setTimeout-scheduled abort) and flaked on
  // a loaded CI runner -- the catch block's own nowImpl() re-check could
  // read a value a fraction of a millisecond *before* the deadline it was
  // itself derived from, since the abort still fires via a real timer
  // (fetchPageWithTimeout's AbortController isn't nowImpl-aware) while
  // the classification decision is. Fixed by making nowImpl's return
  // value deterministic by call count instead of real elapsed time: the
  // first three calls (computing the deadline, the loop's own pre-check,
  // and fetchDeploys's remainingMs calculation -- all of which need to
  // read as "before the deadline" so a real, short timeout actually gets
  // scheduled) return a fixed small value; every call after that
  // (starting with the catch block's post-abort re-check) reads a value
  // far in the future. The real setTimeout still takes real wall-clock
  // ms to fire -- that part can't be faked away -- but the decision being
  // tested no longer races against it.
  let callCount = 0;
  const nowImpl = () => {
    callCount++;
    return callCount <= 3 ? 0 : 1_000_000;
  };
  const result = await waitForDeploy("svc-1", "aaa", "key", {
    fetchImpl,
    sleepImpl: async () => {}, // not reached in this scenario
    maxRuntimeMs: 20, // real ms -- short enough to keep the test fast; no longer load-bearing for correctness, since nowImpl above is what actually decides the outcome
    requestTimeoutMs: 30_000, // would hang for 30s if the deadline clamp weren't cutting it short
    maxAttempts: 5,
    nowImpl,
  });
  assert.deepEqual(result, { readiness: "timed_out", shouldPurge: false });
});

test("waitForDeploy: a genuine error unrelated to the deadline (e.g. a real API failure) still propagates and is not swallowed as timed_out", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => "internal error",
  });
  await assert.rejects(
    () =>
      waitForDeploy("svc-1", "aaa", "key", {
        fetchImpl,
        sleepImpl: async () => {},
        maxRuntimeMs: 60_000, // plenty of budget left -- this isn't a deadline timeout
        maxAttempts: 5,
      }),
    /Render API returned 500/,
  );
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
