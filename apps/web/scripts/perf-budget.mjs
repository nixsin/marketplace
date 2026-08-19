// Codifies this session's manual Lighthouse audit as a runnable script.
// Thresholds below are the §12A targets from TECHNICAL_PLAN.md.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { resolveEnforcedMetrics } from "./perf-enforce.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PORT = 3998;
const BASE_URL = `http://localhost:${PORT}`;

// Single Lighthouse runs on shared GitHub Actions runners swing wildly —
// same commit scored 70, then 85, then 97 across consecutive CI/local runs,
// all driven by `total-blocking-time`/LCP reacting to CPU contention on the
// runner (confirmed locally: 96-97 consistently across 3 back-to-back runs
// on unshared hardware, vs. 70-85 on CI for the identical build). This is
// Lighthouse's own documented failure mode for `simulate` throttling on
// noisy CI hosts, not a real regression each time — taking the median of
// several runs (what Lighthouse CI itself does by default) filters out a
// single contended run without hiding a genuine, consistent regression.
const LIGHTHOUSE_RUNS = 5;

// Which measured budgets are allowed to FAIL the run, as a comma-separated
// list of `score` / `lcp` / `js`. Defaults to all three, so a local
// `pnpm test:perf` still behaves exactly as it always has.
//
// CI's per-PR job sets this to `js` deliberately, and the reason is
// measured rather than assumed. JS transfer is deterministic: PR #94
// reported an identical 192.3KB across a failing run and a passing run of
// the same commit. LCP is not: on 2026-08-19 an unmodified `main` produced
// 1.4s, 2.4s, 2.8s, 2.8s and 3.3s within a single batch of five, and its
// median failed the 2.5s budget outright -- `main` cannot pass its own
// required check reliably. A gate whose false-failure rate exceeds its
// true-failure rate stops being a signal and starts being a tax: this
// session alone it produced misleading failures on #86, #94 and #97, each
// costing an investigation and a rerun.
//
// LCP is still measured, still printed, and still reported into the
// dashboard history on push-to-main -- it moves from "blocks the merge" to
// "tracked as a trend", which is the appropriate treatment for a noisy
// metric. Revisit enforcing it once runs happen on dedicated hardware, or
// once the budget carries enough margin to survive the observed spread.
// Throws on an empty or misspelled value rather than silently enforcing
// nothing -- see perf-enforce.mjs.
const ENFORCED = resolveEnforcedMetrics(process.env.PERF_BUDGET_ENFORCE);

const BUDGETS = {
  performanceScore: 0.9, // /1.0
  lcpMs: 2500, // §12A: LCP < 2.5s on Slow 4G
  // Was the original §12A target (150KB) — raised to match
  // test/bundle-budget.spec.ts's own budget, which has moved several times
  // since then for real, deliberate reasons (see that file's comment). Two
  // scripts measuring the same thing with different numbers is a bug, not
  // two valid opinions; that file's number is the one with the documented
  // history, so this follows it rather than the other way around. Most
  // recent raise (191KB -> 194KB, #94) is also what first made the gap
  // between this script's own Lighthouse-based measurement and that
  // file's curl-based one visible and worth naming: Lighthouse's
  // resource-summary transferSize reads ~3-4KB higher than curl's
  // size_download for the identical build (HTTP response header bytes
  // Chrome's DevTools Protocol counts that curl's body-only measurement
  // doesn't — see "Known gotchas" in CLAUDE.md) — so this script's own
  // margin against this shared number is always a few KB thinner than
  // bundle-budget.spec.ts's is, not a discrepancy to "fix" by giving this
  // script a different number.
  jsBudgetBytes: 194 * 1024,
};

// A manual Lighthouse audit against the deployed site found a real LCP
// regression (3.1s, over budget) on /hi?page=2 specifically — the default
// page below never exercises a non-default locale or a paginated result,
// so it couldn't have caught this. Root cause (product-card.tsx /
// product-listing.tsx, same PR as this) was the LCP image missing
// `priority`; this second page is what makes that class of regression a
// CI failure instead of something only found by chance via a manual
// audit. Same budgets as the default page apply — the JS bundle is
// identical either way, and the LCP budget is a property of the page
// experience, not the locale.
const PAGES = [
  { label: "default (/)", path: "" },
  { label: "/hi?page=2", path: "/hi?page=2" },
];

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`App did not become ready on ${url} in ${timeoutMs}ms`);
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Fresh Chrome per run — reusing one instance across runs risks warm-cache/
// process-state carrying over between them, which would defeat the point of
// independent samples for the median.
async function runOnce(url, n) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless"] });
  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      onlyCategories: ["performance"],
      formFactor: "mobile",
      screenEmulation: { mobile: true, width: 375, height: 667, deviceScaleFactor: 2, disabled: false },
      throttlingMethod: "simulate",
    });
    const { categories, audits } = result.lhr;
    const score = categories.performance.score;
    const lcpMs = audits["largest-contentful-paint"].numericValue;
    const jsBytes =
      audits["resource-summary"]?.details.items.find((i) => i.resourceType === "script")
        ?.transferSize ?? 0;
    console.log(`  run ${n}: score=${(score * 100).toFixed(0)} lcp=${(lcpMs / 1000).toFixed(1)}s js=${(jsBytes / 1024).toFixed(1)}KB`);
    return { score, lcpMs, jsBytes };
  } finally {
    await chrome.kill();
  }
}

async function auditPage(label, url) {
  console.log(`Running Lighthouse ${LIGHTHOUSE_RUNS}x against ${label} (mobile, simulated throttling)...`);
  const runs = [];
  for (let n = 1; n <= LIGHTHOUSE_RUNS; n++) {
    runs.push(await runOnce(url, n));
  }

  const score = median(runs.map((r) => r.score));
  const lcpMs = median(runs.map((r) => r.lcpMs));
  const jsBytes = median(runs.map((r) => r.jsBytes));

  console.log(`
Median of ${LIGHTHOUSE_RUNS} runs for ${label}:
  Performance score: ${(score * 100).toFixed(0)}/100  (budget: >=${BUDGETS.performanceScore * 100})
  LCP: ${(lcpMs / 1000).toFixed(1)}s  (budget: <=${BUDGETS.lcpMs / 1000}s)
  JS transferred: ${(jsBytes / 1024).toFixed(1)}KB  (budget: <=${BUDGETS.jsBudgetBytes / 1024}KB)
`);

  // Every budget is always *measured* and always reported. Which ones are
  // allowed to fail the run is separate -- see ENFORCED above.
  const breaches = [];
  if (score < BUDGETS.performanceScore) breaches.push(["score", "performance score below budget"]);
  if (lcpMs > BUDGETS.lcpMs) breaches.push(["lcp", "LCP exceeds budget"]);
  if (jsBytes > BUDGETS.jsBudgetBytes) breaches.push(["js", "JS transfer exceeds budget"]);

  const failures = breaches.filter(([metric]) => ENFORCED.has(metric));
  for (const [, message] of failures) console.error(`FAIL (${label}): ${message}`);
  for (const [metric, message] of breaches) {
    if (!ENFORCED.has(metric)) {
      console.warn(`WARN (${label}): ${message} — not enforced (PERF_BUDGET_ENFORCE=${[...ENFORCED].join(",")})`);
    }
  }

  return { label, score, lcpMs, jsBytes, failed: failures.length > 0 };
}

async function run() {
  console.log(`Starting production server on ${BASE_URL}...`);
  console.log('(Run "pnpm build" first if this fails to find a build.)');

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: APP_ROOT,
    stdio: "ignore",
  });

  try {
    await waitForReady(BASE_URL, 20_000);

    const results = [];
    for (const page of PAGES) {
      results.push(await auditPage(page.label, `${BASE_URL}${page.path}`));
    }

    // Written unconditionally, before the pass/fail check below — CI's
    // Lighthouse badge/history publishing step (gated on push-to-main,
    // if: always()) reads this regardless of whether the budget itself
    // was met, so the dashboard shows a real regression instead of
    // silently freezing at the last passing score. Opt-in via env var so
    // a plain local `pnpm test:perf` run is unaffected.
    //
    // Scoped to the default page's result only, deliberately — the
    // dashboard's existing history is a single time series measuring that
    // one page; /hi?page=2 is a budget gate only (still fails the whole
    // job below if it regresses), not a second badge/history series. Add
    // one if a non-default page's own trend line ever becomes worth
    // tracking on its own.
    if (process.env.PERF_BUDGET_RESULT_FILE) {
      const [defaultResult] = results;
      writeFileSync(
        process.env.PERF_BUDGET_RESULT_FILE,
        JSON.stringify(
          {
            score: Math.round(defaultResult.score * 100),
            lcpMs: defaultResult.lcpMs,
            jsBytes: defaultResult.jsBytes,
          },
          null,
          2,
        ),
      );
    }

    const failed = results.some((r) => r.failed);
    if (!failed) console.log("OK — within all budgets, on every page tested.");
    process.exitCode = failed ? 1 : 0;
  } finally {
    server.kill();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
