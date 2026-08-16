import { defineConfig, devices } from "@playwright/test";

// Chromium only, deliberately — this is the foundational single-browser
// e2e suite this repo didn't have at all before (every other web test is
// a Vitest/jsdom component test, which never executes in a real browser
// engine). Extending to Firefox/WebKit is the natural next step once this
// proves valuable; a full BrowserStack-style device/OS matrix is a much
// later, separate decision — see CLAUDE.md.
//
// PLAYWRIGHT_BASE_URL lets CI point this at a server it already started
// (build + `next start`, alongside a real API + Postgres) instead of
// having Playwright manage its own — matching how test-web/perf-budget
// build once and reuse that build, not a fresh dev server per test run.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  // Baselines were generated via the exact version-matched official
  // Playwright Docker image (mcr.microsoft.com/playwright:v1.62.1-noble)
  // rather than on the real ubuntu-latest runner itself — verified live
  // that even matched-OS environments running under different
  // virtualization (a local Docker Desktop VM vs. GitHub's actual
  // runner) aren't bit-identical: the first real CI run failed with
  // Playwright reporting "310 pixels (ratio 0.01 of all image pixels)
  // are different", confined to sub-pixel anti-aliasing inside a small
  // decorative SVG icon (confirmed by inspecting the actual diff image
  // from that run's uploaded report) — not any real content difference.
  // A 0% tolerance is unrealistic for cross-environment screenshot
  // testing in general (font hinting/anti-aliasing is never perfectly
  // deterministic across machines even with identical software
  // versions) — this is standard practice for visual regression
  // tooling, not a workaround specific to this one diff. Set to 0.03,
  // not exactly the observed 0.01, deliberately — matching the observed
  // value exactly would sit right at the boundary and could still fail
  // on the next run's slightly different sub-pixel noise; real margin
  // above it is the point. A genuine layout/content regression moves far
  // more than 3% of pixels, so this doesn't meaningfully weaken the
  // check.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.03 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Only used for local `pnpm test:e2e` — CI starts the server itself as
  // a separate step (see ci.yml's test-e2e-web job) so the server logs
  // stay visible in the job output instead of buried in Playwright's own
  // webServer capture.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm start",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
