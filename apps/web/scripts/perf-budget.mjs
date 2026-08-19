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
import { resolveEnforcedMetrics } from "./perf-enforce.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PORT = 3998;
const BASE_URL = `http://localhost:${PORT}`;

// Every threshold here now comes from @medinstru/config, imported above --
// including LIGHTHOUSE_RUNS, whose own "single runs swing wildly on shared
// runners" reasoning lives alongside it there. jsBudgetBytes in particular
// used to be declared separately in this file *and* in
// test/bundle-budget.spec.ts, two scripts measuring the same thing with
// independently-editable numbers, held in sync only by a CLAUDE.md note
// saying they "must move together." One shared constant makes that
// structural rather than remembered.

// Which measured budgets are allowed to FAIL the run, as a comma-separated
// list of `score` / `lcp` / `js`. Defaults to all three, so a local
// `pnpm test:perf` behaves exactly as it always has.
//
// CI's per-PR job sets this to `js` deliberately, and the reason is
// measured rather than assumed. JS transfer is deterministic: PR #94
// reported an identical 192.3KB across a failing run and a passing run of
// the same commit. LCP is not: on 2026-08-19 an unmodified `main` produced
// 1.4s, 2.4s, 2.8s, 2.8s and 3.3s within a single batch of five, and its
// median failed the 2.5s budget outright -- `main` could not pass its own
// required check reliably. Across the last 40 CI runs this job executed 10
// times and failed 7, only one of which involved a real JS regression.
//
// LCP is still measured, printed, and published to the dashboard history --
// it moves from "blocks the merge" to "tracked as a trend". Throws on an
// empty or misspelled value rather than silently enforcing nothing; see
// perf-enforce.mjs.
const ENFORCED = resolveEnforcedMetrics(process.env.PERF_BUDGET_ENFORCE);

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
