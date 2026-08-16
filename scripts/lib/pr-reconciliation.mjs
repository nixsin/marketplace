// Pure decision logic for the pr-reconciliation job's three checks.
// Extracted after five real bugs were found in the equivalent inline
// bash across three live-review rounds (missing --repo, invalid --jq
// --arg, false-resolution on failed lookups, an unhandled UNKNOWN
// mergeStateStatus, unchecked marker-lookup pipes) plus a sixth found in
// the same round that finally asked for this: a failed PR-enumeration
// lookup was indistinguishable from "genuinely zero open PRs," reporting
// success either way. No I/O here — scripts/decide-*.mjs are the CLI
// wrappers that call `gh`/`jq` and feed the results in.

const STUCK_THRESHOLD_SECONDS = 86400;

// Bugs 1 and 5 (this round): `pr_numbers=$(gh pr list ...)` failing
// produces the same empty result as a genuinely empty PR list, so a
// real API/auth failure silently reported "nothing to do" instead of
// "couldn't check" — the scheduled safety net looked successful while
// doing zero reconciliation. `lookupOk` must come from the caller's own
// exit-status check, not be inferred from whether the string is empty.
export function decideEnumeration({ lookupOk, prNumbers }) {
  if (!lookupOk) return { action: "fail", reason: "enumeration-lookup-failed" };
  if (!prNumbers || prNumbers.length === 0) {
    return { action: "no-op", reason: "no-open-prs" };
  }
  return { action: "proceed", reason: "has-open-prs" };
}

// Bugs 2 and 4: a failed mergeStateStatus lookup, or one that succeeded
// but returned the real (not an error) GraphQL enum value UNKNOWN while
// GitHub is still computing mergeability, must not be treated the same
// as "confirmed not DIRTY" — both used to fall through to resolving a
// real, possibly still-active conflict.
export function decideConflictAction({
  lookupOk,
  commentLookupOk,
  mergeStatus,
  existingCommentId,
}) {
  if (!lookupOk || !commentLookupOk) {
    return { action: "skip", reason: "lookup-failed" };
  }
  if (mergeStatus === "DIRTY") return { action: "flag", reason: "dirty" };
  if (mergeStatus === "UNKNOWN") return { action: "skip", reason: "unknown" };
  if (existingCommentId) return { action: "resolve", reason: "clean" };
  return { action: "skip", reason: "clean-no-existing-flag" };
}

function runIsStuck(run, nowEpoch, thresholdSeconds) {
  if (!run || run.conclusion !== "action_required" || !run.createdAt) {
    return false;
  }
  const createdEpoch = Math.floor(new Date(run.createdAt).getTime() / 1000);
  if (Number.isNaN(createdEpoch)) return false;
  return nowEpoch - createdEpoch > thresholdSeconds;
}

// This repo has more than one workflow that triggers per push (CI and
// CodeQL, confirmed live) — a live review caught that checking only the
// single most recent run (`gh run list --limit 1`) meant that if two
// workflows exist for the same revision and one is action_required while
// the other has already resolved (or is simply newer by a hair), the
// check could see whichever one happened to sort last and miss the
// real stuck one entirely, or worse, incorrectly resolve a real,
// still-active warning. `runs` must be every run for the PR's *current*
// head commit (across every workflow, filtered by `gh run list
// --commit`) — stuck if ANY of them is.
export function isStuck({
  runs,
  nowEpoch,
  thresholdSeconds = STUCK_THRESHOLD_SECONDS,
}) {
  return (runs ?? []).some((run) => runIsStuck(run, nowEpoch, thresholdSeconds));
}

// Bug 3, same shape as decideConflictAction: a failed gh pr view/gh run
// list lookup must not be treated as "confirmed not stuck."
export function decideStuckAction({
  lookupOk,
  commentLookupOk,
  runs,
  nowEpoch,
  existingCommentId,
}) {
  if (!lookupOk || !commentLookupOk) {
    return { action: "skip", reason: "lookup-failed" };
  }
  if (isStuck({ runs, nowEpoch })) {
    return { action: "flag", reason: "stuck" };
  }
  if (existingCommentId) return { action: "resolve", reason: "not-stuck" };
  return { action: "skip", reason: "not-stuck-no-existing-flag" };
}
