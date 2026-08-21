/**
 * Mutation testing — deciding what to mutate and how to read the result.
 *
 * WHY THIS EXISTS. Nothing else in this repo catches a test that passes
 * for the wrong reason, and that failure mode has occurred three times
 * here, each time producing false confidence rather than a red build:
 *
 *   1. A `migrate` invariant whose regex matched a COMMENT, so the rule
 *      it guarded could be deleted and the test stayed green.
 *   2. A Dockerfile guard using toContain(), satisfied by an unrelated
 *      ENV line -- it would not have caught the exact bug it was written
 *      for. Confirmed by deleting the ARG: six tests still passed.
 *   3. An og-image test that re-imported a module with a cache-busting
 *      query, which under some conditions resolved the ORIGINAL module
 *      and asserted nothing.
 *
 * Each was found by hand, by deliberately breaking the code and checking
 * the test noticed. That is a mechanical process, which is the argument
 * for automating it.
 *
 * SCOPE. Deliberately narrow. Mutation testing is expensive -- every
 * mutant re-runs a test suite -- so this targets the code where a silent
 * failure is most costly: guards, validators and parsers whose whole
 * purpose is to REJECT something. A bug in rendering shows up on screen;
 * a bug in a guard shows up as an outage nobody was warned about.
 */

/**
 * Source files worth mutating, and why each earns the cost.
 *
 * Kept as an explicit list rather than a glob: a glob would silently grow
 * to cover files where mutation testing is not worth the runtime, and the
 * budget would then be spent by accident rather than by decision.
 */
export const MUTATION_TARGETS = [
  {
    file: "apps/web/src/lib/site-url.ts",
    why: "refuses a deploy; a false negative ships dead share links",
  },
  {
    file: "apps/web/src/lib/og-image.ts",
    why: "path validation; a false negative advertises a 404 or traverses",
  },
  {
    file: "apps/api/src/observability/correlation.ts",
    why: "sanitises untrusted headers written straight into logs",
  },
  {
    file: "apps/api/src/storage/blob-store.ts",
    why: "key validation; a false negative writes outside the storage root",
  },
];

/**
 * Mutation operators.
 *
 * Chosen to mimic the mistakes actually made in this codebase rather than
 * a textbook list: an inverted or weakened condition, a boundary moved by
 * one, a guard clause removed entirely.
 */
export const OPERATORS = [
  { name: "negate-condition", find: /\bif \(!/g, replace: "if (" },
  { name: "weaken-and", find: / && /g, replace: " || " },
  { name: "strengthen-or", find: / \|\| /g, replace: " && " },
  { name: "off-by-one-gt", find: / > /g, replace: " >= " },
  { name: "off-by-one-lt", find: / < /g, replace: " <= " },
  { name: "always-true", find: /\.test\(/g, replace: ".notTest(" },
];

/**
 * Whether the suite genuinely detected a mutant.
 *
 * A mutant that makes the suite ERROR rather than fail (a syntax error, a
 * module that will not load) proves nothing about assertion quality -- it
 * is reported separately so a run cannot look good because it broke the
 * runner.
 */
export function classifyMutant({ exitCode, stderr = "" }) {
  if (/SyntaxError|Cannot find module|Transform failed/.test(stderr)) {
    return "invalid";
  }
  return exitCode === 0 ? "survived" : "killed";
}

/**
 * A survived mutant means some line can be broken with no test noticing.
 *
 * Reported as a failure, because that is the entire point -- but only
 * `survived` counts. `invalid` mutants are excluded from the score rather
 * than counted as kills, which would flatter it.
 */
export function summarizeMutants(results) {
  const killed = results.filter((r) => r.status === "killed").length;
  const survived = results.filter((r) => r.status === "survived").length;
  const invalid = results.filter((r) => r.status === "invalid").length;
  const scored = killed + survived;
  return {
    killed,
    survived,
    invalid,
    score: scored === 0 ? null : Math.round((killed / scored) * 100),
  };
}

/**
 * The score below which a run fails.
 *
 * NOT 100, deliberately. Some mutants are EQUIVALENT -- they change the
 * source without changing behaviour, so no test can possibly kill them.
 * The clearest examples here are the defence-in-depth branches in
 * site-url.ts: Node's URL parser rejects a malformed address before the
 * octet-range and IPv6-shape checks ever run, so weakening those
 * conditions is undetectable. They are correct code and worth keeping;
 * they are simply unreachable from the public entry point.
 *
 * Demanding 100% would mean writing tests for unreachable branches, and
 * a tool that demands the impossible gets switched off. 85 is set just
 * below the measured score so a real REGRESSION trips it while the known
 * equivalents do not.
 */
export const MINIMUM_SCORE = 85;

/** Markdown report, survivors first — they are the only actionable part. */
export function formatMutationReport(results) {
  const { killed, survived, invalid, score } = summarizeMutants(results);
  // The icon tracks the THRESHOLD, not the raw survivor count -- a few
  // equivalent mutants are expected and do not make the run bad. Showing
  // ❌ next to a passing exit code would teach people to ignore the icon.
  const failing = score !== null && score < MINIMUM_SCORE;
  const lines = [
    `## ${failing ? "❌" : "✅"} Mutation testing — ${score ?? "n/a"}% killed` +
      (score !== null ? ` (threshold ${MINIMUM_SCORE}%)` : ""),
    "",
    `${killed} killed · ${survived} survived` + (invalid ? ` · ${invalid} invalid (excluded)` : ""),
    "",
  ];

  if (score !== null && score < MINIMUM_SCORE) {
    lines.push(
      `**Below the ${MINIMUM_SCORE}% threshold.** A survivor is a line that can`,
      "be broken with no test noticing.",
      "",
    );
  }

  if (survived) {
    lines.push(
      "Each survivor is a line that can be broken with no test noticing.",
      "",
      "| File | Line | Mutation |",
      "|---|---|---|",
      ...results
        .filter((r) => r.status === "survived")
        .map((r) => `| \`${r.file}\` | ${r.line} | ${r.operator} |`),
      "",
    );
  }
  return lines.join("\n");
}
