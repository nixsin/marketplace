#!/usr/bin/env node
// CLI wrapper around pr-reconciliation.mjs's decideStuckAction — prints
// exactly one of: flag | resolve | skip. See pr-reconciliation.yml's
// "Reconcile every open PR targeting main" step for how this is invoked.
//
// Takes `runs` as a JSON array (every workflow run for the PR's current
// head commit — see CLAUDE.md's "PR reconciliation" section for why a
// single most-recent run isn't enough once a repo has more than one
// workflow triggering per push), not individual conclusion/createdAt
// args. Unparseable JSON forces lookupOk to false (see below) — never
// just an empty runs array with lookupOk left as whatever bash passed
// in, which read as "confirmed zero stuck runs" and could falsely
// resolve a real, still-active warning.
import { decideStuckAction, parseRunsJson } from "./lib/pr-reconciliation.mjs";

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

// A live review caught that this previously defaulted `runs` to []
// on a parse failure but left `lookupOk` exactly as passed in from
// bash — which, if bash's own gh calls had succeeded (a malformed
// JSON string isn't necessarily a gh failure), meant
// decideStuckAction saw {lookupOk: true, runs: []}, indistinguishable
// from "confirmed zero stuck runs," and could falsely resolve a real,
// still-active warning. A parse failure must force lookupOk to false
// itself, not just supply an empty runs array and leave the caller's
// success flag untouched.
let runs = [];
let parseOk = true;
try {
  runs = JSON.parse(runsJsonArg);
} catch (err) {
  console.error(`Failed to parse runs JSON, treating as a failed lookup: ${err.message}`);
  parseOk = false;
}

console.log(
  decideStuckAction({
    lookupOk: lookupOkArg === "true" && parseOk,
    commentLookupOk: commentLookupOkArg === "true",
    runs,
    nowEpoch: Number(nowEpochArg),
    existingCommentId: existingCommentId ?? "",
  }).action,
);
