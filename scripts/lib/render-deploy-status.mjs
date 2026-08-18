// Pure logic behind #78 §1.4's deploy-time purge, resequenced against the
// right event. The plan's own finding: "CI's last step" is wrong --
// render.yaml's autoDeployTrigger: checksPass means Render *reacts* to CI
// passing and starts its own deploy afterward, a separate asynchronous
// stage. Purging right when CI finishes races a Render deploy that may
// not have started yet:
//
//   purge fires -> edge asks origin -> origin is STILL the old deployment
//   -> edge caches the old version again -> new deploy finally goes live,
//   too late
//
// The purge must fire after Render confirms the specific new commit is
// actually live, not after CI finishes. This is the polling/classification
// half of that -- built and tested now even though there's no CDN to
// purge yet (#78 Part 1's own blocking prerequisite), so it's ready to
// wire in once one exists. Render's real deploy status enum (confirmed
// via api-docs.render.com, not assumed): created, queued,
// build_in_progress, update_in_progress, live, deactivated, build_failed,
// update_failed, canceled, pre_deploy_in_progress, pre_deploy_failed.

const LIVE_STATUS = "live";

// A deploy that was live for this commit but has since been superseded by
// an even newer one -- distinct from a real failure. Not something to
// alert on the same way a build failure is: it means, by the time this
// was checked, the world had already moved on to a newer commit. Worth
// its own classification rather than lumping into "failed" so a caller
// can decide differently (e.g. "purge anyway, something newer is live
// now" vs. "stop and alert, the build is broken").
const SUPERSEDED_STATUS = "deactivated";

const TERMINAL_FAILURE_STATUSES = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "pre_deploy_failed",
]);

// deploys: the raw array of deploy objects from GET /services/{id}/deploys
// (each already unwrapped from that endpoint's {deploy, cursor} pagination
// shape -- see fetchDeploys in the CLI wrapper). targetCommitSha: the git
// commit this purge is waiting on. Render's own deploys list is already
// newest-first, but this doesn't assume that -- it explicitly picks the
// single deploy whose commit matches, not just "the first one found".
export function findDeployForCommit(deploys, targetCommitSha) {
  return deploys.find((d) => d.commit?.id === targetCommitSha) ?? null;
}

// One of: "not_found" (no deploy exists yet for this commit -- Render's
// own trigger hasn't picked it up, or the list hasn't paginated far
// enough back), "pending" (deploying, keep polling), "live" (safe to
// purge), "failed" (a real build/update failure -- stop polling and
// alert, purging won't help), "superseded" (this commit did or didn't go
// live, but an even newer commit already has -- stop polling, but this
// is a benign race, not a failure).
export function classifyDeployReadiness(deploy) {
  if (!deploy) return "not_found";
  if (deploy.status === LIVE_STATUS) return "live";
  if (deploy.status === SUPERSEDED_STATUS) return "superseded";
  if (TERMINAL_FAILURE_STATUSES.has(deploy.status)) return "failed";
  return "pending";
}

export function shouldStopPolling(readiness) {
  return readiness !== "not_found" && readiness !== "pending";
}

// Whether the purge should actually fire, given a final (post-polling)
// readiness state. Only a genuinely live deploy for the exact target
// commit justifies purging -- a failure obviously shouldn't, and neither
// should "superseded": purging now would be reacting to a commit that's
// already stale by the time this state was reached, not the one CI
// actually asked to wait for.
export function shouldPurge(readiness) {
  return readiness === "live";
}
