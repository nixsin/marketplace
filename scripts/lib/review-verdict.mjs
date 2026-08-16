// Pure parsing/validation logic for the ai-code-review job's verdict.
// Extracted out of .github/workflows/ci.yml's inline bash so it's
// independently testable (see review-verdict.test.mjs) — the bash version
// had three real bugs across successive review rounds (first-occurrence
// matching fooled by injected text, `tr -d` collapsing internal whitespace
// so "APP ROVE" matched "APPROVE", and a `set -e`-triggered silent abort on
// zero matches) before landing on the logic here. No I/O in this file —
// the CLI wrappers (parse-review-verdict.mjs, parse-force-run-jobs.mjs) do
// the file reading.

const KNOWN_HEADINGS = ["## Files reviewed", "## Force-run jobs", "## Verdict"];

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

// Generic section extractor: takes the content after the LAST occurrence
// of `heading`, up to the next line that matches ANY known heading (not
// just the specific one this section is normally followed by) — the
// prompt's structure is Files reviewed -> Force-run jobs -> Verdict, and a
// naive "stop at ## Verdict only" would swallow the Force-run jobs section
// into Files reviewed. Resets on every occurrence of `heading`, so only
// the final (rightmost) instance survives if the text contains more than
// one — same reasoning as extractVerdict's single-heading requirement,
// applied here as "take the last, not all of them" instead, since these
// two sections aren't independently security-critical enough to warrant
// the stricter exactly-one rule (an APPROVE can never proceed from a
// malformed Verdict section regardless of what these two contain).
function extractSection(reviewText, heading) {
  const lines = reviewText.split("\n");
  let current = [];
  let collecting = false;
  for (const line of lines) {
    if (line === heading) {
      collecting = true;
      current = [];
      continue;
    }
    if (collecting && KNOWN_HEADINGS.includes(line)) {
      collecting = false;
      continue;
    }
    if (collecting) current.push(line);
  }
  return current.map((l) => l.trim()).filter((l) => l.length > 0);
}

// Only meaningful once extractVerdict has already confirmed exactly one
// "## Verdict" heading exists.
export function extractFilesReviewed(reviewText) {
  return extractSection(reviewText, "## Files reviewed");
}

// Whitelist-validated: only job IDs from `allowedJobIds` survive. This
// list ends up interpolated into a `gh workflow run` call downstream, so
// anything the model wrote that isn't an exact match to a known job ID —
// hallucinated, malformed, or an injection attempt — is silently dropped
// rather than passed through. "none" (any case) or an empty/missing
// section both correctly produce an empty list.
export function extractForceRunJobs(reviewText, allowedJobIds) {
  const section = extractSection(reviewText, "## Force-run jobs").join(" ");
  const candidates = section
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== "none");
  return [...new Set(candidates.filter((id) => allowedJobIds.includes(id)))];
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
