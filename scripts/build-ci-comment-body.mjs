#!/usr/bin/env node
// CLI wrapper around ci-progress-comment.mjs's buildCommentBody -- prints
// the full comment markdown to stdout. See comment-ci-result-on-pr's
// steps in ci.yml.
import { buildCommentBody } from "./lib/ci-progress-comment.mjs";

const [marker, heading, note, table, runUrl] = process.argv.slice(2);
if (
  marker === undefined ||
  heading === undefined ||
  note === undefined ||
  table === undefined ||
  runUrl === undefined
) {
  console.error(
    "Usage: build-ci-comment-body.mjs <marker> <heading> <note> <table> <runUrl>",
  );
  process.exit(1);
}

console.log(buildCommentBody({ marker, heading, note, table, runUrl }));
