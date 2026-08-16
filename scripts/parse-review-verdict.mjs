#!/usr/bin/env node
// Thin CLI wrapper around scripts/lib/review-verdict.mjs — reads the
// reviewer's raw output and the PR's actual changed-files list, prints
// exactly "APPROVE" or "REQUEST_CHANGES" to stdout. See the "Post review
// verdict" step in .github/workflows/ci.yml for how this gets invoked.
import { readFileSync } from "node:fs";
import { decideVerdict } from "./lib/review-verdict.mjs";

const [reviewPath, actualFilesPath] = process.argv.slice(2);
if (!reviewPath || !actualFilesPath) {
  console.error(
    "Usage: parse-review-verdict.mjs <review.md> <actual-changed-files.txt>",
  );
  process.exit(1);
}

const reviewText = readFileSync(reviewPath, "utf8");
const actualChangedFiles = readFileSync(actualFilesPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

console.log(decideVerdict({ reviewText, actualChangedFiles }));
