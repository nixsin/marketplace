import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENFORCE,
  VALID_METRICS,
  resolveEnforcedMetrics,
} from "./perf-enforce.mjs";

describe("resolveEnforcedMetrics", () => {
  test("unset enforces every metric, so a local run is unchanged", () => {
    assert.deepEqual([...resolveEnforcedMetrics(undefined)].sort(), ["js", "lcp", "score"]);
    assert.equal(DEFAULT_ENFORCE, "score,lcp,js");
  });

  test("enforces exactly the named subset — the ci.yml case", () => {
    assert.deepEqual([...resolveEnforcedMetrics("js")], ["js"]);
  });

  test("tolerates whitespace and casing", () => {
    assert.deepEqual([...resolveEnforcedMetrics(" JS , Lcp ")].sort(), ["js", "lcp"]);
  });

  // The failure mode a review caught in the first version: a gate that
  // enforces nothing still prints, still looks like it ran, and passes
  // unconditionally. Empty or misspelled input must stop the run.
  test("throws on an empty value rather than enforcing nothing", () => {
    assert.throws(() => resolveEnforcedMetrics(""), /names no metric/);
    assert.throws(() => resolveEnforcedMetrics("   "), /names no metric/);
    assert.throws(() => resolveEnforcedMetrics(",,"), /names no metric/);
  });

  test("throws on a misspelled metric rather than silently ignoring it", () => {
    // `jss` would otherwise resolve to an empty set and disable the very
    // budget it was meant to configure.
    assert.throws(() => resolveEnforcedMetrics("jss"), /unrecognized metric/);
    assert.throws(() => resolveEnforcedMetrics("js,lpc"), /unrecognized metric/);
  });

  test("the error names the valid options so the fix is obvious", () => {
    try {
      resolveEnforcedMetrics("nope");
      assert.fail("expected a throw");
    } catch (err) {
      for (const metric of VALID_METRICS) assert.match(err.message, new RegExp(metric));
    }
  });
});
