#!/usr/bin/env node
// CLI wrapper around ci-progress-comment.mjs's computeProgress -- prints
// a single JSON object {table, done, hasFailure, hasCancelled} that the
// comment-ci-result-on-pr job's bash parses with jq. See that job's
// steps in ci.yml and CLAUDE.md's "Post-merge CI result" section.
import { computeProgress } from "./lib/ci-progress-comment.mjs";

const [jobsJsonArg, trackedNamesJsonArg] = process.argv.slice(2);
if (jobsJsonArg === undefined || trackedNamesJsonArg === undefined) {
  console.error(
    "Usage: compute-ci-progress.mjs <jobs-json> <tracked-names-json>",
  );
  process.exit(1);
}

const jobs = JSON.parse(jobsJsonArg);
const trackedNames = JSON.parse(trackedNamesJsonArg);

const { table, done, hasFailure, hasCancelled } = computeProgress({
  jobs,
  trackedNames,
});
console.log(JSON.stringify({ table, done, hasFailure, hasCancelled }));
