#!/usr/bin/env node
// CLI wrapper around pr-reconciliation.mjs's decideStuckAction — prints
// exactly one of: flag | resolve | skip. See pr-reconciliation.yml's
// "Reconcile every open PR targeting main" step for how this is invoked.
import { decideStuckAction } from "./lib/pr-reconciliation.mjs";

const [
  lookupOkArg,
  commentLookupOkArg,
  conclusion,
  createdAt,
  nowEpochArg,
  existingCommentId,
] = process.argv.slice(2);
if (
  lookupOkArg === undefined ||
  commentLookupOkArg === undefined ||
  nowEpochArg === undefined
) {
  console.error(
    "Usage: decide-stuck-action.mjs <true|false> <true|false> <conclusion> <createdAt> <nowEpoch> <existingCommentId>",
  );
  process.exit(1);
}

console.log(
  decideStuckAction({
    lookupOk: lookupOkArg === "true",
    commentLookupOk: commentLookupOkArg === "true",
    conclusion: conclusion ?? "",
    createdAt: createdAt ?? "",
    nowEpoch: Number(nowEpochArg),
    existingCommentId: existingCommentId ?? "",
  }).action,
);
