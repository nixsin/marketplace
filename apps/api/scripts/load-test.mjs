// Codifies this session's manual autocannon benchmark as a runnable script.
// Informational, not a hard CI gate — local throughput/latency numbers vary
// too much by machine to be a reliable pass/fail gate. Run it periodically
// and after any change to the request path (resolvers, DB queries, middleware).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import autocannon from "autocannon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PORT = 4099;
const BASE_URL = `http://localhost:${PORT}`;

// Generous thresholds — flags a real regression (e.g. an accidental N+1
// query) without being noisy about normal machine-to-machine variance.
const P99_LATENCY_BUDGET_MS = 50;

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
  throw new Error(`API did not become ready on ${url} in ${timeoutMs}ms`);
}

function startApi() {
  const child = spawn("node", ["dist/src/main.js"], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  return child;
}

async function run() {
  console.log("Building...");
  await new Promise((resolve, reject) => {
    const build = spawn("npx", ["nest", "build"], {
      cwd: APP_ROOT,
      stdio: "inherit",
    });
    build.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build exited ${code}`)),
    );
  });

  console.log(`Starting API on ${BASE_URL}...`);
  const api = startApi();
  try {
    await waitForReady(BASE_URL, 20_000);

    console.log("Running load test against the products query (15s, 20 connections)...");
    const result = await autocannon({
      url: `${BASE_URL}/graphql`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ products(limit: 6) { nextCursor items { id name brand category deviceClass certifications location seller { name type } } } }",
      }),
      connections: 20,
      duration: 15,
    });

    console.log(`
Results:
  Requests/sec (avg): ${result.requests.average}
  Latency p50:  ${result.latency.p50}ms
  Latency p97.5: ${result.latency.p97_5}ms
  Latency p99:  ${result.latency.p99}ms
  2xx responses: ${result[Object.keys(result).find((k) => k === "2xx")] ?? "n/a"}
  Errors: ${result.errors}
  Timeouts: ${result.timeouts}
`);

    if (result.errors > 0 || result.non2xx > 0) {
      console.error(`FAIL: ${result.errors} errors, ${result.non2xx} non-2xx responses`);
      process.exitCode = 1;
    } else if (result.latency.p99 > P99_LATENCY_BUDGET_MS) {
      console.warn(
        `WARNING: p99 latency ${result.latency.p99}ms exceeds informational budget of ${P99_LATENCY_BUDGET_MS}ms`,
      );
    } else {
      console.log("OK — within expected range.");
    }
  } finally {
    api.kill();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
