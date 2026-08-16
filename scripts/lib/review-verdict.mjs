// Pure parsing/validation logic for the ai-code-review job's verdict.
// Extracted out of .github/workflows/ci.yml's inline bash so it's
// independently testable (see review-verdict.test.mjs) — the bash version
// had three real bugs across successive review rounds (first-occurrence
// matching fooled by injected text, `tr -d` collapsing internal whitespace
// so "APP ROVE" matched "APPROVE", and a `set -e`-triggered silent abort on
// zero matches) before landing on the logic here. No I/O in this file —
// the CLI wrapper (parse-review-verdict.mjs) does the file reading.

// A malformed/adversarial response must never be mistaken for a genuine
// one. The contract (stated in ai-code-review.mjs's prompt) is exactly one
// "## Verdict" heading, as the true final content of the response. Instead
// of picking "the right one" among several candidates, we require there to
// be exactly one candidate at all — more than one (whether injected-and-
// quoted from the diff, or a genuine duplicate) already violates the
// contract and disqualifies the whole response.
export function extractVerdict(reviewText) {
  const lines = reviewText.split("\n");
  const headingIndexes = [];
  lines.forEach((line, i) => {
    if (line === "## Verdict") headingIndexes.push(i);
  });

  if (headingIndexes.length !== 1) return null;

  const value = (lines[headingIndexes[0] + 1] ?? "").trim();

  const lastNonBlank = [...lines].reverse().find((l) => l.trim() !== "");
  if (value !== (lastNonBlank ?? "").trim()) return null;

  return value;
}

// Takes the LAST "## Files reviewed" section before the "## Verdict"
// heading — resets on every occurrence of the heading, so if the text
// contains more than one (e.g. quoted from the diff), only the final one
// survives. Only meaningful once extractVerdict has already confirmed
// exactly one "## Verdict" heading exists.
export function extractFilesReviewed(reviewText) {
  const lines = reviewText.split("\n");
  let current = [];
  let collecting = false;
  for (const line of lines) {
    if (line === "## Files reviewed") {
      collecting = true;
      current = [];
      continue;
    }
    if (line === "## Verdict") {
      collecting = false;
      continue;
    }
    if (collecting) current.push(line);
  }
  return current.map((l) => l.trim()).filter((l) => l.length > 0);
}

function sameFileSet(a, b) {
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return (
    sortedA.length === sortedB.length &&
    sortedA.every((f, i) => f === sortedB[i])
  );
}

// The single entry point the CLI wrapper calls. Defaults to
// REQUEST_CHANGES on every path except a clean, fully-verified APPROVE —
// mirrors the workflow's own fail-closed philosophy: anything ambiguous,
// malformed, or unverifiable is not trusted. `diffWasTruncated` is an
// unconditional override, checked first: a live review caught that the
// model can list the right file names and say APPROVE having never seen
// a truncated file's full content — the files-list check alone can't
// catch that, since names can be correct while content is incomplete.
export function decideVerdict({
  reviewText,
  actualChangedFiles,
  diffWasTruncated,
}) {
  if (diffWasTruncated) return "REQUEST_CHANGES";

  const rawVerdict = extractVerdict(reviewText);
  if (rawVerdict !== "APPROVE") return "REQUEST_CHANGES";

  const claimedFiles = extractFilesReviewed(reviewText);
  return sameFileSet(claimedFiles, actualChangedFiles)
    ? "APPROVE"
    : "REQUEST_CHANGES";
}
