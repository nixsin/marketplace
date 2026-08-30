import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const WEB_ROOT = join(import.meta.dirname, "..");
const TOKEN = "test-token-for-the-suite-only";
const PORT = 3974;
const BASE = `http://localhost:${PORT}`;

/**
 * Source maps must be unreachable without the access token, and whole with it.
 *
 * `productionBrowserSourceMaps: true` stays on -- a production stack trace
 * resolving to a real file and line is worth having. What is not worth having
 * is `next start` serving those maps to anyone: they inline the complete
 * original text of every file, `packages/config` included, which publishes
 * every rate limit and ceiling the app has. Measured against production on
 * 2026-08-30, that was 2.38 MB of readable source and the exact numbers behind
 * the accepted DoS surface in #152.
 *
 * Driven over real HTTP against the production server, because the property
 * belongs to how Next actually serves files -- the whole failure was that
 * `.next/static` is public, which no unit test of our own code could see.
 */
describe("source map access", () => {
  let server: ChildProcess;
  let mapName: string;

  beforeAll(async () => {
    const dir = join(WEB_ROOT, ".next", "sourcemaps");
    expect(
      existsSync(dir),
      ".next/sourcemaps is missing — did `next build` run the privatize step?",
    ).toBe(true);

    const maps = readdirSync(dir).filter((f) => f.endsWith(".map"));
    // Without this the assertions below would pass vacuously the day the
    // build stops emitting maps or the directory moves.
    expect(maps.length).toBeGreaterThan(0);
    mapName = maps[0];

    server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
      cwd: WEB_ROOT,
      stdio: "pipe",
      env: { ...process.env, SOURCEMAP_ACCESS_TOKEN: TOKEN },
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${BASE}/en`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("next start did not become ready");
  }, 40_000);

  afterAll(() => {
    server?.kill();
  });

  it("does NOT serve maps from the public static path any more", async () => {
    // The original exposure, asserted directly: this exact URL returned the
    // full map with inlined source on production.
    const res = await fetch(`${BASE}/_next/static/chunks/${mapName}`);

    expect(res.status).toBe(404);
  });

  it("refuses a request with no cookie", async () => {
    expect((await fetch(`${BASE}/sourcemaps/${mapName}`)).status).toBe(404);
  });

  it("refuses a WRONG token", async () => {
    const res = await fetch(`${BASE}/sourcemaps/${mapName}`, {
      headers: { cookie: "mi_srcmap=not-the-token" },
    });

    expect(res.status).toBe(404);
  });

  it("404s rather than 403, so the route is indistinguishable from absent", async () => {
    // A 403 would confirm the path exists and something is behind it. There
    // is nothing to gain from telling an unauthorised caller that.
    const res = await fetch(`${BASE}/sourcemaps/${mapName}`);

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("serves the WHOLE map to a session holding the token", async () => {
    // Whole, not stripped: the point of gating rather than deleting the
    // source is that an authorised session loses nothing.
    const res = await fetch(`${BASE}/sourcemaps/${mapName}`, {
      headers: { cookie: `mi_srcmap=${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const map = (await res.json()) as { sourcesContent?: unknown; sources?: unknown };
    expect(Array.isArray(map.sources)).toBe(true);
    expect(map.sourcesContent).toBeDefined();
  });

  it("never lets a gated response into a shared cache", async () => {
    // The response varies by cookie. An edge that stored one would hand it to
    // everyone, undoing the gate entirely.
    const res = await fetch(`${BASE}/sourcemaps/${mapName}`, {
      headers: { cookie: `mi_srcmap=${TOKEN}` },
    });

    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it.each([
    "../BUILD_ID",
    "..%2f..%2fBUILD_ID",
    "not-a-map.txt",
    "evil.js.map.txt",
  ])("refuses the filename %p", async (name) => {
    // The name comes from the URL and indexes a directory inside the deployed
    // image, so it is validated against the shapes `next build` emits rather
    // than merely checked for traversal.
    const res = await fetch(`${BASE}/sourcemaps/${name}`, {
      headers: { cookie: `mi_srcmap=${TOKEN}` },
    });

    expect(res.status).toBe(404);
  });
});
