import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const APP_ROOT = path.resolve(__dirname, "../..");

export interface StartedServer {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
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
  throw new Error(`Server at ${url} did not become ready in ${timeoutMs}ms`);
}

// Starts the PRODUCTION build (`next start`) on a dedicated port. Assumes
// `pnpm --filter web build` has already run — these tests assert real
// production behavior (caching headers, bundle size), which `next dev`
// doesn't represent.
export async function startProdServer(port = 3999): Promise<StartedServer> {
  const child: ChildProcess = spawn(
    "npx",
    ["next", "start", "-p", String(port)],
    { cwd: APP_ROOT, stdio: "pipe" },
  );

  const baseUrl = `http://localhost:${port}`;
  try {
    await waitForReady(baseUrl, 20_000);
  } catch (err) {
    child.kill();
    throw new Error(
      `${(err as Error).message}\nDid you run "pnpm --filter web build" first?`,
    );
  }

  return {
    port,
    baseUrl,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}
