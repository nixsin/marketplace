import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cspAllowsImageHost,
  extractOgContent,
  decodeHtmlEntities,
  imageSourcesFrom,
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

describe("cspAllowsImageHost", () => {
  const HOST = "https://images.laxair.shop";

  test("blocked when img-src omits the host", () => {
    // The failure that matters: every product image fails in the browser
    // while curl sees a perfectly good page.
    assert.equal(
      cspAllowsImageHost("default-src 'self'; img-src 'self'", HOST),
      false,
    );
  });

  test("a substring match elsewhere in the policy does not count", () => {
    // The original check passed here, because the origin appears in
    // connect-src -- while img-src still blocks the image.
    assert.equal(
      cspAllowsImageHost(`img-src 'self'; connect-src ${HOST}`, HOST),
      false,
    );
  });

  test("a scheme source permits the host without naming it", () => {
    // The original check FAILED here, warning about a policy that
    // genuinely allows the image.
    assert.equal(cspAllowsImageHost("img-src https:", HOST), true);
  });

  test("falls back to default-src, per the CSP spec", () => {
    assert.equal(cspAllowsImageHost(`default-src ${HOST}`, HOST), true);
  });

  test("honours a wildcard host", () => {
    assert.equal(cspAllowsImageHost("img-src https://*.laxair.shop", HOST), true);
  });

  test("a bare * allows everything", () => {
    assert.equal(cspAllowsImageHost("img-src *", HOST), true);
  });

  test("null when nothing restricts images", () => {
    // Distinct from "blocked" -- the caller reports these differently.
    assert.equal(cspAllowsImageHost("script-src 'self'", HOST), null);
    assert.equal(imageSourcesFrom("script-src 'self'"), null);
  });
});

describe("extractOgContent", () => {
  test("finds the tag in the usual serialization", () => {
    assert.equal(
      extractOgContent('<meta property="og:image" content="a.png"/>', "image"),
      "a.png",
    );
  });

  test("tolerates content before property", () => {
    // Valid HTML the original regex reported as missing.
    assert.equal(
      extractOgContent('<meta content="a.png" property="og:image">', "image"),
      "a.png",
    );
  });

  test("tolerates single quotes", () => {
    assert.equal(
      extractOgContent("<meta property='og:image' content='a.png'>", "image"),
      "a.png",
    );
  });

  test("decodes entities so the URL is fetchable", () => {
    // Fetching the raw attribute text meant requesting a literal &amp;
    // and getting a 404 for an image that was fine.
    assert.equal(
      extractOgContent('<meta property="og:image" content="a.png?x=1&amp;y=2">', "image"),
      "a.png?x=1&y=2",
    );
  });

  test("does not confuse one og property for another", () => {
    const html = '<meta property="og:image:width" content="1200"><meta property="og:image" content="a.png">';
    assert.equal(extractOgContent(html, "image"), "a.png");
  });

  test("undefined when genuinely absent", () => {
    assert.equal(extractOgContent("<meta name=\"x\" content=\"y\">", "image"), undefined);
  });
});

describe("decodeHtmlEntities", () => {
  test("covers the entities that appear in URLs and titles", () => {
    assert.equal(decodeHtmlEntities("a&amp;b&#x27;c&quot;d"), "a&b'c\"d");
  });
});
