import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { signSourcemapToken } from "@medinstru/config/sourcemap-token";

const WEB_ROOT = join(import.meta.dirname, "..");
const KEY = "signing-key-for-the-suite-only-long-enough";

/** A token minted the way the CLI mints one. */
function mint(overrides: Partial<Parameters<typeof signSourcemapToken>[0]> = {}) {
  return signSourcemapToken({ issuer: "suite@example.com", key: KEY, ...overrides }).token;
}
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
  let allMaps: string[];

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
    allMaps = maps;

    server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
      cwd: WEB_ROOT,
      stdio: "pipe",
      env: { ...process.env, SOURCEMAP_SIGNING_KEY: KEY },
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

  it("serves EVERY map the build moved, not just one", async () => {
    // The build script moves every `.map` it finds; the route serves only
    // names matching a pattern. Those were two separate regexes and they
    // disagreed -- a map with any other basename would be moved, repointed,
    // and then 404 forever, silently, because the reference in the chunk
    // still looked right. They now share one definition, and this asserts
    // the whole set rather than maps[0], which could not have caught it.
    const failed: string[] = [];
    for (const name of allMaps) {
      const res = await fetch(`${BASE}/sourcemaps/${name}`, {
        headers: { cookie: `mi_srcmap=${mint()}` },
      });
      if (res.status !== 200) failed.push(`${name} -> ${res.status}`);
    }

    expect(failed).toEqual([]);
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

  it("refuses a token signed with a DIFFERENT key", async () => {
    const res = await fetch(`${BASE}/sourcemaps/${mapName}`, {
      headers: { cookie: `mi_srcmap=${mint({ key: "a-different-signing-key-also-long-enough" })}` },
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
      headers: { cookie: `mi_srcmap=${mint()}` },
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
      headers: { cookie: `mi_srcmap=${mint()}` },
    });

    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("refuses an EXPIRED token, even though the signature is valid", async () => {
    // Time-bounding is the revocation mechanism -- there is no server-side
    // state to clear, so a grant that outlives its window must be refused on
    // its own claims.
    const stale = signSourcemapToken({
      issuer: "stale@example.com",
      key: KEY,
      ttlSeconds: 60,
      now: Date.now() - 60 * 60 * 1000,
    }).token;

    const res = await fetch(`${BASE}/sourcemaps/${mapName}`, {
      headers: { cookie: `mi_srcmap=${stale}` },
    });

    expect(res.status).toBe(404);
  });

  it("refuses a token whose payload was edited after signing", async () => {
    // The payload is readable by design -- it says who the token belongs to.
    // Readable must not mean editable.
    const token = mint();
    const [version, payload, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, "base64url").toString()) as object),
        iss: "someone-else@example.com",
      }),
    ).toString("base64url");

    const res = await fetch(`${BASE}/sourcemaps/${mapName}`, {
      headers: { cookie: `mi_srcmap=${version}.${tampered}.${signature}` },
    });

    expect(res.status).toBe(404);
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
      headers: { cookie: `mi_srcmap=${mint()}` },
    });

    expect(res.status).toBe(404);
  });
});
