// Codifies this session's manual Lighthouse audit as a runnable script.
// Informational, not a hard CI gate — Lighthouse scores have real run-to-run
// variance. Thresholds below are the §12A targets from TECHNICAL_PLAN.md.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PORT = 3998;
const BASE_URL = `http://localhost:${PORT}`;

const BUDGETS = {
  performanceScore: 0.9, // /1.0
  lcpMs: 2500, // §12A: LCP < 2.5s on Slow 4G
  // Was the original §12A target (150KB) — raised to match
  // test/bundle-budget.spec.ts's own budget, which has moved twice since
  // then for real, deliberate reasons (see that file's comment). Two
  // scripts measuring the same thing with different numbers is a bug, not
  // two valid opinions; that file's number is the one with the documented
  // history, so this follows it rather than the other way around.
  jsBudgetBytes: 186 * 1024,
};

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

async function run() {
  console.log(`Starting production server on ${BASE_URL}...`);
  console.log('(Run "pnpm build" first if this fails to find a build.)');

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: APP_ROOT,
    stdio: "ignore",
  });

  const chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless"],
  });

  try {
    await waitForReady(BASE_URL, 20_000);

    console.log("Running Lighthouse (mobile, simulated throttling)...");
    const result = await lighthouse(BASE_URL, {
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

    console.log(`
Results:
  Performance score: ${(score * 100).toFixed(0)}/100  (budget: >=${BUDGETS.performanceScore * 100})
  LCP: ${(lcpMs / 1000).toFixed(1)}s  (budget: <=${BUDGETS.lcpMs / 1000}s)
  JS transferred: ${(jsBytes / 1024).toFixed(1)}KB  (budget: <=${BUDGETS.jsBudgetBytes / 1024}KB)
`);

    let failed = false;
    if (score < BUDGETS.performanceScore) {
      console.error(`FAIL: performance score below budget`);
      failed = true;
    }
    if (lcpMs > BUDGETS.lcpMs) {
      console.error(`FAIL: LCP exceeds budget`);
      failed = true;
    }
    if (jsBytes > BUDGETS.jsBudgetBytes) {
      console.error(`FAIL: JS transfer exceeds budget`);
      failed = true;
    }
    if (!failed) console.log("OK — within all budgets.");
    process.exitCode = failed ? 1 : 0;
  } finally {
    await chrome.kill();
    server.kill();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
