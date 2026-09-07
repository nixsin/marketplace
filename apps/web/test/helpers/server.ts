import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
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

/**
 * A port nothing is listening on, chosen by the OS.
 *
 * Binding to 0 makes the kernel pick a free port; we read it back and release
 * it immediately. There is a small window in which something else could take
 * it, which is unavoidable without handing the listening socket to the child
 * -- and vastly smaller than the alternative this replaces.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the PRODUCTION build (`next start`) on a port nothing else is using.
 *
 * Assumes `pnpm --filter web build` has already run -- these tests assert real
 * production behaviour (caching headers, bundle size), which `next dev` does
 * not represent.
 *
 * THE PORT IS ALLOCATED, NOT FIXED, and that is the whole point of this
 * function's signature. It used to default to 3999, which two suites took:
 * bundle-budget and static-caching. Vitest runs files in parallel, so whenever
 * scheduling put them together the second could not bind, `waitForReady`
 * polled a server that was never coming, and seven tests died on a 30s timeout
 * apiece -- 240 seconds of a CI job spent proving nothing.
 *
 * It was latent for as long as those two happened not to overlap, and surfaced
 * when an unrelated spec file was ADDED and shifted the scheduling. That is
 * the tell: a failure that appears when you add a test elsewhere is about
 * shared state, not about the test you added.
 *
 * locale-cookie-caching already passed 3998 explicitly to dodge this, which is
 * evidence someone hit it before and worked around the instance rather than
 * the cause.
 */
export async function startProdServer(
  port?: number,
): Promise<StartedServer> {
  port ??= await freePort();
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
