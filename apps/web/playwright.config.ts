import {
  DEV_API_URL,
  DEV_BLOB_BASE_URL,
  DEV_SITE_URL,
} from "@medinstru/config";
import { DEPLOY_ENVIRONMENT } from "@medinstru/config/env-contract";
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
  // tooling, not a workaround specific to this one diff.
  //
  // maxDiffPixels (an absolute count), not maxDiffPixelRatio — a real
  // gap an AI review round caught in the first version of this fix,
  // which used `maxDiffPixelRatio: 0.03`. That's 3% of the *entire*
  // 1280x720 viewport (~27,600 pixels) — a real but small, localized
  // regression (a missing icon, a wrong button color, a clipped label)
  // can easily stay under that while still being a genuine bug the
  // suite exists to catch. 600 is real margin above the observed 310
  // (not set to exactly 310, which would sit right at the boundary and
  // could still fail on the next run's slightly different sub-pixel
  // noise) while staying tight enough that any UI element of
  // meaningful size — even a small ~25x25px icon (~625px) — still
  // trips it.
  expect: {
    toHaveScreenshot: { maxDiffPixels: 600 },
  },
  // Chromium runs the whole suite. The other engines and device profiles run
  // only the two engine-agnostic specs, via testMatch: cross-browser.spec.ts
  // (rendering, script errors, network health) and scenarios.spec.ts (text
  // wrapping, glyph width, horizontal overflow, card collision). Both are
  // pure measurements with no baselines, so fanning them across five
  // projects costs one page load each and never a regenerated PNG.
  //
  // The reason is screenshots: critical-flow.spec.ts asserts against
  // baselines, and baselines are per-project. Running it on five projects
  // would mean five sets of Linux-generated PNGs to regenerate on every
  // intentional UI change -- a permanent maintenance cost far larger than
  // the coverage it buys, since business logic does not differ by engine.
  // What DOES differ is rendering, script errors and network behaviour,
  // which is exactly what cross-browser.spec.ts checks.
  //
  // WebKit matters most of the five. It is the engine with the largest
  // real behavioural distance from Chromium, and it is what every iOS
  // browser uses regardless of its name -- a significant share of this
  // app's target market on mobile.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      testMatch: /(cross-browser|scenarios)\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "firefox",
      testMatch: /(cross-browser|scenarios)\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "mobile-safari",
      testMatch: /(cross-browser|scenarios)\.spec\.ts/,
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "mobile-chrome",
      testMatch: /(cross-browser|scenarios)\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  // Only used for local `pnpm test:e2e` — CI starts the server itself as
  // a separate step (see ci.yml's test-e2e-web job) so the server logs
  // stay visible in the job output instead of buried in Playwright's own
  // webServer capture.
  //
  // `pnpm build && pnpm start`, not just `pnpm start` — a real gap an AI
  // review round caught: on a fresh checkout with no prior `.next` build,
  // plain `pnpm start` has nothing to serve, so the suite failed outright
  // rather than just showing stale content. Reproduced directly (`rm -rf
  // .next && pnpm exec playwright test`) before fixing, then confirmed
  // the fix with a real `pnpm build` from a clean state.
  //
  // What this still doesn't do, deliberately: start Postgres or the API.
  // Those are the same prerequisites docs/development.md's own "Testing"
  // section already assumes for apps/api's e2e suite (a running Postgres, with
  // `apps/api` started separately) — this suite needs the identical
  // setup, not a new pattern. Automating that from inside a Playwright
  // config would duplicate what `scripts/dev.sh` already does for the
  // full stack; run that (or start the API by hand) before `pnpm
  // test:e2e` locally. CI's test-e2e-web job does this itself as
  // separate steps — see CLAUDE.md.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm build && pnpm start",
        // Every contract variable, from @medinstru/config rather than as
        // literals -- the same values docker-compose.yml and ci.yml use, so
        // there is one definition of "the localhost API" instead of six.
        //
        // APP_ENV is stated because `next build` and `next start` both set
        // NODE_ENV=production: without it the check sees a production-looking
        // process with no platform markers and reports an unrecognised
        // environment on every local run. It is a developer machine; say so.
        env: {
          APP_ENV: DEPLOY_ENVIRONMENT.LOCALHOST,
          NEXT_PUBLIC_API_URL: DEV_API_URL,
          NEXT_PUBLIC_SITE_URL: DEV_SITE_URL,
          NEXT_PUBLIC_BLOB_BASE_URL: DEV_BLOB_BASE_URL,
          SOURCEMAP_SIGNING_KEY: "",
        },
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
