#!/usr/bin/env node
// Thin CLI wrapper around scripts/lib/review-verdict.mjs — reads the
// reviewer's raw output, the PR's actual changed-files list, and the
// diff-truncation flag ai-code-review.mjs wrote, then prints exactly
// "APPROVE" or "REQUEST_CHANGES" to stdout. See the "Post review verdict"
// step in .github/workflows/ci.yml for how this gets invoked.
import { readFileSync } from "node:fs";
import { decideVerdict } from "./lib/review-verdict.mjs";

const [reviewPath, actualFilesPath, truncatedFlagPath] = process.argv.slice(2);
if (!reviewPath || !actualFilesPath || !truncatedFlagPath) {
  console.error(
    "Usage: parse-review-verdict.mjs <review.md> <actual-changed-files.txt> <truncated-flag-file>",
  );
  process.exit(1);
}

const reviewText = readFileSync(reviewPath, "utf8");
const actualChangedFiles = readFileSync(actualFilesPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

// Fail closed if the flag file is missing or unreadable for any reason —
// treat "we don't know whether the diff was truncated" the same as
// "it was truncated", never the same as "it wasn't".
let diffWasTruncated = true;
try {
  diffWasTruncated = readFileSync(truncatedFlagPath, "utf8").trim() === "true";
} catch {
  // missing/unreadable — diffWasTruncated stays true
}

console.log(decideVerdict({ reviewText, actualChangedFiles, diffWasTruncated }));
