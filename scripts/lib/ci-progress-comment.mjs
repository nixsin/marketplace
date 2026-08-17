// Pure logic behind the live-updating "CI running" PR comment
// (comment-ci-result-on-pr job in ci.yml). Extracted after ai-code-review
// flagged a real conclusion-classification bug here (PR #66), then asked
// for committed test coverage of the surrounding polling/comment-update
// logic specifically -- the same "pull pure logic into a tested module"
// move already proven on pr-reconciliation.mjs, review-verdict.mjs, and
// override-decisions.mjs.

// A completed GitHub Actions job's `conclusion` can be success, skipped,
// cancelled, failure, timed_out, action_required, stale, neutral, or
// null/absent. Only success and skipped mean "this job did what it
// should" -- an earlier version of this logic only checked
// `conclusion === "failure"`, which left e.g. a timed_out job reported
// as part of a passing run. Fail closed instead: anything that isn't an
// explicit success/skipped/cancelled counts as a failure.
export function classifyJobDisplay(job) {
  if (job == null) return "pending";
  if (job.status !== "completed") return job.status;
  return job.conclusion ?? "unknown";
}

function isOkConclusion(conclusion) {
  return conclusion === "success" || conclusion === "skipped";
}

// jobs: the raw array from GET /repos/{owner}/{repo}/actions/runs/{id}/jobs
// (each at least {name, status, conclusion}). trackedNames: the fixed,
// ordered list of job display names this comment reports on -- mirrors
// migrate's own needs: list plus the informational jobs migrate
// deliberately excludes (perf-budget/load-test/test-e2e-web); see
// CLAUDE.md's "Post-merge CI result" section.
export function computeProgress({ jobs, trackedNames }) {
  const rows = trackedNames.map((name) => ({
    name,
    job: jobs.find((j) => j.name === name) ?? null,
  }));

  const table = rows
    .map((r) => `| ${r.name} | ${classifyJobDisplay(r.job)} |`)
    .join("\n");

  const done = rows.every(
    (r) => r.job != null && r.job.status === "completed",
  );
  const hasCancelled = rows.some((r) => r.job?.conclusion === "cancelled");
  const hasFailure = rows.some(
    (r) =>
      r.job != null &&
      r.job.status === "completed" &&
      !isOkConclusion(r.job.conclusion) &&
      r.job.conclusion !== "cancelled",
  );

  return { rows, table, done, hasFailure, hasCancelled };
}

export function buildCommentBody({ marker, heading, note, table, runUrl }) {
  return [
    marker,
    heading,
    "",
    note,
    "",
    "| Job | Result |",
    "|---|---|",
    table,
    "",
    `Run: ${runUrl}`,
  ].join("\n");
}

// Poll-loop stopping condition: stop once every tracked job is done, or
// once maxIterations is reached -- a hard bound distinct from the job's
// own GitHub Actions timeout-minutes, so a genuine runner outage gets an
// explicit "still waiting" comment instead of running silently for the
// full timeout with no explanation.
export function shouldStopPolling({ iteration, maxIterations, done }) {
  return done || iteration >= maxIterations;
}

export function decideStatusLine({ timedOut, hasFailure, hasCancelled }) {
  if (timedOut) {
    return "⏱️ Still waiting on this run after 30 minutes of polling — longer than any run in this workflow's history, worth checking directly.";
  }
  if (hasFailure) {
    return "❌ **One or more checks failed** on the push-to-main run for this merge.";
  }
  if (hasCancelled) {
    return "⚠️ One or more checks were **cancelled** on the push-to-main run for this merge.";
  }
  return "✅ All checks passed on the push-to-main run for this merge.";
}
