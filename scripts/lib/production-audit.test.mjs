import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDeadline,
  daysUntil,
  formatReport,
  overallStatus,
  summarize,
} from "./production-audit.mjs";

describe("overallStatus", () => {
  test("a single failure fails the run", () => {
    assert.equal(overallStatus([{ status: "pass" }, { status: "fail" }]), "fail");
  });

  test("warnings never fail the run", () => {
    // Deliberate: free-tier spin-down, a marginal cert window and a deploy
    // lagging main by minutes are all worth REPORTING and none are worth
    // paging for. An audit that cries wolf gets muted, which is worse than
    // not having one.
    assert.equal(overallStatus([{ status: "pass" }, { status: "warn" }]), "warn");
  });

  test("skips do not affect the outcome", () => {
    // A third-party lookup being down is not our outage.
    assert.equal(overallStatus([{ status: "pass" }, { status: "skip" }]), "pass");
  });

  test("all-clear passes", () => {
    assert.equal(overallStatus([{ status: "pass" }]), "pass");
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-08-20T00:00:00Z");

  test("counts whole days forward", () => {
    assert.equal(daysUntil("2026-09-14T00:00:00Z", now), 25);
  });

  test("goes negative once the date has passed", () => {
    // Must not read as a large positive window -- that would silently
    // stop reporting the moment a deadline was missed.
    assert.equal(daysUntil("2026-08-18T00:00:00Z", now), -2);
  });

  test("same day is zero", () => {
    assert.equal(daysUntil("2026-08-20T00:00:00Z", now), 0);
  });
});

describe("classifyDeadline", () => {
  test("two thresholds, because the useful signal differs", () => {
    // warn = schedule this; fail = this is now urgent. One threshold
    // either nags for weeks or gives no notice at all.
    assert.equal(classifyDeadline(60), "pass");
    assert.equal(classifyDeadline(20), "warn");
    assert.equal(classifyDeadline(3), "fail");
  });

  test("boundaries are inclusive on the worse side", () => {
    assert.equal(classifyDeadline(30), "warn");
    assert.equal(classifyDeadline(7), "fail");
    assert.equal(classifyDeadline(31), "pass");
  });

  test("an already-passed deadline fails", () => {
    assert.equal(classifyDeadline(-5), "fail");
  });

  test("thresholds are configurable per deadline", () => {
    assert.equal(classifyDeadline(10, { warnAt: 14, failAt: 3 }), "warn");
    assert.equal(classifyDeadline(2, { warnAt: 14, failAt: 3 }), "fail");
  });
});

describe("summarize", () => {
  test("counts every status", () => {
    const counts = summarize([
      { status: "pass" }, { status: "pass" }, { status: "warn" },
      { status: "fail" }, { status: "skip" },
    ]);
    assert.deepEqual(counts, { pass: 2, warn: 1, fail: 1, skip: 1 });
  });
});

describe("formatReport", () => {
  const results = [
    { area: "Availability", name: "Web responds", status: "pass", detail: "HTTP 200" },
    { area: "Previews", name: "og:image present", status: "fail", detail: "MISSING" },
    { area: "Previews", name: "og:title", status: "pass", detail: "Title" },
  ];

  test("leads with the overall verdict", () => {
    const md = formatReport(results);
    assert.match(md, /^## ❌ Production audit — FAIL/);
  });

  test("collapses a fully green area to one line", () => {
    // A report where everything is equally prominent is one nobody reads
    // to the end of.
    const md = formatReport(results);
    assert.match(md, /### ✅ Availability — all 1 checks passed/);
    assert.ok(!md.includes("| ✅ | Web responds"));
  });

  test("lists failures first within an area", () => {
    const md = formatReport(results);
    const fail = md.indexOf("og:image present");
    const pass = md.indexOf("og:title");
    assert.ok(fail < pass, "the failure should appear above the passing check");
  });

  test("includes the live build when known", () => {
    assert.match(formatReport(results, { commit: "abc1234" }), /abc1234/);
  });

  test("an all-green run reads as passing", () => {
    const md = formatReport([{ area: "A", name: "x", status: "pass" }]);
    assert.match(md, /^## ✅ Production audit — PASS/);
  });
});
