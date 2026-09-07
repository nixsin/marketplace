import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startProdServer } from "./server";

const TEST_DIR = join(import.meta.dirname, "..");

describe("startProdServer", () => {
  it("gives each caller a different port", async () => {
    // The property that makes parallel suites safe. Two suites sharing a
    // fixed port meant the second could not bind, waitForReady polled a
    // server that was never coming, and seven tests died on a 30s timeout
    // apiece -- surfaced only when an unrelated spec file was added and
    // shifted vitest's scheduling.
    const a = await startProdServer(undefined as unknown as number);
    const b = await startProdServer(undefined as unknown as number);
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 60_000);

  it("NO spec pins a port, which is how the collision happened", () => {
    // Enforced rather than remembered. locale-cookie-caching used to pass
    // 3998 explicitly to dodge the shared default -- a workaround for the
    // instance rather than the cause, and exactly the shape that leaves the
    // next suite to rediscover it.
    const offenders: string[] = [];
    for (const name of readdirSync(TEST_DIR)) {
      if (!name.endsWith(".spec.ts")) continue;
      const source = readFileSync(join(TEST_DIR, name), "utf8");
      for (const m of source.matchAll(/startProdServer\(\s*(\d+)/g)) {
        offenders.push(`${name} pins port ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
