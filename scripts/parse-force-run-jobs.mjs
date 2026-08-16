#!/usr/bin/env node
// Thin CLI wrapper around scripts/lib/review-verdict.mjs's
// extractForceRunJobs — reads the reviewer's raw output, prints a
// comma-separated list of whitelisted job IDs to force-run (empty string
// if none). See the "Force-run skipped CI jobs" step in
// .github/workflows/ci.yml for how this gets invoked and what it does
// with the output.
import { readFileSync } from "node:fs";
import { extractForceRunJobs } from "./lib/review-verdict.mjs";

// Keep this in sync with the identical list in ai-code-review.mjs's
// prompt and the `if:` conditions in ci.yml — these are the only jobs
// this mechanism is allowed to force-run.
const FORCEABLE_JOBS = [
  "audit",
  "test-api-unit",
  "test-api-e2e",
  "test-web",
  "perf-budget",
  "load-test",
  "docker-scan",
  "docker-smoke",
  "test-e2e-web",
];

const [reviewPath] = process.argv.slice(2);
if (!reviewPath) {
  console.error("Usage: parse-force-run-jobs.mjs <review.md>");
  process.exit(1);
}

const reviewText = readFileSync(reviewPath, "utf8");
console.log(extractForceRunJobs(reviewText, FORCEABLE_JOBS).join(","));
