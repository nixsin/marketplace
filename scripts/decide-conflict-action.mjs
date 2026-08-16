#!/usr/bin/env node
// CLI wrapper around pr-reconciliation.mjs's decideConflictAction —
// prints exactly one of: flag | resolve | skip. See pr-reconciliation.yml's
// "Reconcile every open PR targeting main" step for how this is invoked.
import { decideConflictAction } from "./lib/pr-reconciliation.mjs";

const [lookupOkArg, commentLookupOkArg, mergeStatus, existingCommentId] =
  process.argv.slice(2);
if (lookupOkArg === undefined || commentLookupOkArg === undefined) {
  console.error(
    "Usage: decide-conflict-action.mjs <true|false> <true|false> <mergeStatus> <existingCommentId>",
  );
  process.exit(1);
}

console.log(
  decideConflictAction({
    lookupOk: lookupOkArg === "true",
    commentLookupOk: commentLookupOkArg === "true",
    mergeStatus: mergeStatus ?? "",
    existingCommentId: existingCommentId ?? "",
  }).action,
);
