#!/usr/bin/env node
// CLI wrapper around ci-progress-comment.mjs's decideStatusLine -- prints
// the final banner line for the comment-ci-result-on-pr job.
import { decideStatusLine } from "./lib/ci-progress-comment.mjs";

const [timedOutArg, hasFailureArg, hasCancelledArg] = process.argv.slice(2);
if (
  timedOutArg === undefined ||
  hasFailureArg === undefined ||
  hasCancelledArg === undefined
) {
  console.error(
    "Usage: decide-ci-status-line.mjs <true|false> <true|false> <true|false>",
  );
  process.exit(1);
}

console.log(
  decideStatusLine({
    timedOut: timedOutArg === "true",
    hasFailure: hasFailureArg === "true",
    hasCancelled: hasCancelledArg === "true",
  }),
);
