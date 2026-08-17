import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Each test writes to its own uniquely-named file (not a shared
// read-modify-write file) specifically because Playwright runs these in
// parallel workers (fullyParallel: true, playwright.config.ts) -- a
// shared file would race. A CI step combines both after the run to
// publish the "accessibility" dashboard badge (see ci.yml and CLAUDE.md's
// "Badges and the metrics dashboard" section). Only writes when the env
// var is set, so local `pnpm test:e2e` runs are unaffected.
function recordResult(locale: string, violationCount: number) {
  const dir = process.env.ACCESSIBILITY_RESULT_DIR;
  if (!dir) return;
  writeFileSync(
    join(dir, `accessibility-${locale}.json`),
    JSON.stringify({ locale, violationCount }),
  );
}

// Automated accessibility check against the real running app -- catches
// what's mechanically detectable (contrast, missing labels, ARIA misuse,
// landmark structure) via axe-core, the same engine Lighthouse's own
// accessibility category uses under the hood. Not a substitute for manual
// testing (keyboard-only navigation, screen readers) -- axe-core itself
// only claims to catch ~30-50% of WCAG issues -- but a real, repeatable
// floor that runs on every push. WCAG 2.1 A and AA tags specifically,
// matching this repo's contrast work in globals.css.
test.describe("accessibility", () => {
  test("home page (en) has no automatically detectable violations", async ({
    page,
  }) => {
    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    // Recorded before the assertion -- a failing test should still leave
    // an accurate violation count behind for the badge, not silently
    // produce no data just because the test itself throws next.
    recordResult("en", results.violations.length);
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test("home page (hi) has no automatically detectable violations", async ({
    page,
  }) => {
    await page.goto("/hi");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    recordResult("hi", results.violations.length);
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
