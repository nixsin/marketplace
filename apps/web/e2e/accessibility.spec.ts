import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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

    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
