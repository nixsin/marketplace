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

// Uses the tested parseRunsJson helper directly — a live review caught
// that an earlier version of this wrapper imported it but then
// duplicated its logic inline instead of actually calling it, so the
// wrapper's real code path (as opposed to the pure functions in
// isolation) was never exercised by the test suite. That inline version
// also had the actual bug parseRunsJson exists to prevent: it defaulted
// `runs` to [] on a parse failure but left `lookupOk` exactly as passed
// in from bash, so a malformed JSON string with an otherwise-successful
// gh call read as {lookupOk: true, runs: []} — indistinguishable from
// "confirmed zero stuck runs" — and could falsely resolve a real,
// still-active warning.
const { runs, parseOk } = parseRunsJson(runsJsonArg);
if (!parseOk) {
  console.error("Failed to parse runs JSON, treating as a failed lookup");
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
