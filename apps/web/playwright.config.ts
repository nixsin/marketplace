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
