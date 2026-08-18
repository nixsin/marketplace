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
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
