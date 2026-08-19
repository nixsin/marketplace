// Codifies this session's manual Lighthouse audit as a runnable script.
// Thresholds below are the §12A targets from TECHNICAL_PLAN.md.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import {
  JS_BUDGET_BYTES,
  LCP_BUDGET_MS,
  LIGHTHOUSE_RUNS,
  PERFORMANCE_SCORE_BUDGET,
} from "@medinstru/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PORT = 3998;
const BASE_URL = `http://localhost:${PORT}`;

// Every threshold here now comes from @medinstru/config, imported above.
// jsBudgetBytes in particular used to be declared separately in this file
// *and* in test/bundle-budget.spec.ts — two scripts measuring the same
// thing with independently-editable numbers, held in sync only by a
// CLAUDE.md note saying they "must move together." One shared constant
// makes that structural rather than remembered. See the config module and
// bundle-budget.spec.ts's own comment for the raise history and for why
// Lighthouse reads a few KB higher than curl for an identical build.
const BUDGETS = {
  performanceScore: PERFORMANCE_SCORE_BUDGET,
  lcpMs: LCP_BUDGET_MS,
  jsBudgetBytes: JS_BUDGET_BYTES,
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

  const failures = [];
  if (score < BUDGETS.performanceScore) failures.push("performance score below budget");
  if (lcpMs > BUDGETS.lcpMs) failures.push("LCP exceeds budget");
  if (jsBytes > BUDGETS.jsBudgetBytes) failures.push("JS transfer exceeds budget");
  for (const f of failures) console.error(`FAIL (${label}): ${f}`);

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
