// Pure resolution of which measured performance budgets are allowed to
// FAIL a run. Deliberately a separate module from perf-budget.mjs: that
// file runs Lighthouse at import time, so importing it from a test would
// launch Chrome. Keeping this side-effect-free is what makes it testable.
//
// This is merge-gating logic -- if it resolves to "enforce nothing", the
// performance check still prints, still looks like it ran, and passes
// unconditionally. A local review caught exactly that failure mode in the
// first version, which silently accepted an empty or misspelled value.
// Fail loudly on anything unrecognized instead: a typo'd
// PERF_BUDGET_ENFORCE=jss should stop the run, never quietly disable the
// budget it was meant to configure.

export const VALID_METRICS = ["score", "lcp", "js"];

// Matches perf-budget.mjs's historical behaviour: everything is enforced
// unless a caller narrows it, so a plain local `pnpm test:perf` is
// unchanged by this feature existing.
export const DEFAULT_ENFORCE = "score,lcp,js";

/**
 * @param {string|undefined} raw  value of PERF_BUDGET_ENFORCE
 * @returns {Set<string>} metrics whose breach should fail the run
 * @throws if the value names no recognized metric, or any unknown one
 */
export function resolveEnforcedMetrics(raw) {
  const source = raw ?? DEFAULT_ENFORCE;
  const tokens = source
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error(
      `PERF_BUDGET_ENFORCE is set but names no metric. Expected a comma-separated subset of: ${VALID_METRICS.join(", ")}. ` +
        "Refusing to run a performance gate that would enforce nothing.",
    );
  }

  const unknown = tokens.filter((t) => !VALID_METRICS.includes(t));
  if (unknown.length > 0) {
    throw new Error(
      `PERF_BUDGET_ENFORCE contains unrecognized metric(s): ${unknown.join(", ")}. ` +
        `Expected a comma-separated subset of: ${VALID_METRICS.join(", ")}.`,
    );
  }

  return new Set(tokens);
}
