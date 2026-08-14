import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProdServer, type StartedServer } from "./helpers/server";

// Automates the manual `curl -I` check from the earlier performance session:
// hashed static assets must be cached forever, the favicon must be cached
// for a real but finite window, and HTML must NOT be immutable-cached
// (it needs to go stale so ISR/content updates are actually visible).
describe("static asset caching (production build)", () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startProdServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("caches hashed JS/CSS chunks forever (immutable, 1 year)", async () => {
    const html = await (await fetch(server.baseUrl)).text();
    const chunkPath = html.match(
      /<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/,
    )?.[1];
    expect(chunkPath, "expected to find a <script src=\"/_next/static/*.js\"> tag in the HTML").toBeDefined();

    const res = await fetch(`${server.baseUrl}${chunkPath}`);
    const cacheControl = res.headers.get("cache-control") ?? "";

    expect(cacheControl).toContain("immutable");
    expect(cacheControl).toContain("max-age=31536000");
  });

  it("caches the favicon for a real but finite window (not immutable — its URL never changes)", async () => {
    const res = await fetch(`${server.baseUrl}/favicon.ico`);
    const cacheControl = res.headers.get("cache-control") ?? "";
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);

    expect(maxAgeMatch, `expected a max-age on favicon.ico, got "${cacheControl}"`).toBeDefined();
    const maxAge = Number(maxAgeMatch![1]);

    expect(maxAge).toBeGreaterThan(3600); // real caching, not effectively none
    expect(cacheControl).not.toContain("immutable"); // must go stale eventually
  });

  it("does NOT immutably cache the HTML document (content must be able to go stale)", async () => {
    const res = await fetch(server.baseUrl);
    const cacheControl = res.headers.get("cache-control") ?? "";

    expect(cacheControl).not.toContain("immutable");
  });
});
