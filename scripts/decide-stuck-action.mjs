#!/usr/bin/env node
// CLI wrapper around pr-reconciliation.mjs's decideStuckAction — prints
// exactly one of: flag | resolve | skip. See pr-reconciliation.yml's
// "Reconcile every open PR targeting main" step for how this is invoked.
//
// Takes `runs` as a JSON array (every workflow run for the PR's current
// head commit — see CLAUDE.md's "PR reconciliation" section for why a
// single most-recent run isn't enough once a repo has more than one
// workflow triggering per push), not individual conclusion/createdAt
// args. Fails closed to lookupOk=false semantics (an empty runs list) on
// unparseable JSON, same reasoning as parse-override-decisions.mjs: this
// only ever removes a signal, never fabricates a false "not stuck."
import { decideStuckAction } from "./lib/pr-reconciliation.mjs";

const [
  lookupOkArg,
  commentLookupOkArg,
  runsJsonArg,
  nowEpochArg,
  existingCommentId,
] = process.argv.slice(2);
if (
  lookupOkArg === undefined ||
  commentLookupOkArg === undefined ||
  runsJsonArg === undefined ||
  nowEpochArg === undefined
) {
  console.error(
    "Usage: decide-stuck-action.mjs <true|false> <true|false> <runs-json> <nowEpoch> <existingCommentId>",
  );
  process.exit(1);
}

let runs = [];
try {
  runs = JSON.parse(runsJsonArg);
} catch (err) {
  console.error(`Failed to parse runs JSON, treating as empty: ${err.message}`);
}

console.log(
  decideStuckAction({
    lookupOk: lookupOkArg === "true",
    commentLookupOk: commentLookupOkArg === "true",
    runs,
    nowEpoch: Number(nowEpochArg),
    existingCommentId: existingCommentId ?? "",
  }).action,
);
