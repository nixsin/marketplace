import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProdServer, type StartedServer } from "./helpers/server";

const execFileAsync = promisify(execFile);

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

  it("serves the locale shell as prerendered/static, not re-rendered per request", async () => {
    // Items-for-sale were deliberately split out of this route into a
    // client-fetched component (see product-listing.tsx) specifically so
    // this page has no server-side data dependency left and can be fully
    // static per locale — this asserts that split actually worked, not
    // just that it compiles.
    const res = await fetch(`${server.baseUrl}/en`);
    // Node's fetch joins repeated response headers with ", " — Next.js
    // sends this one twice — so check presence, not exact equality.
    expect(res.headers.get("x-nextjs-prerender")).toContain("1");
  });

  it("answers a conditional re-request for the shell with 304, not a full re-render", async () => {
    // What "reload with the same language should come from cache, not the
    // server" actually looks like over HTTP: the browser sends back the
    // ETag it already has, and gets an empty 304 instead of the full
    // document — no re-render, negligible transfer, even without a
    // service worker.
    //
    // One warm-up request first: a brand-new server process hasn't cached
    // this route yet, and conditional revalidation only kicks in once it
    // has — matches how this was verified manually against an
    // already-warm server.
    //
    // curl, not fetch(): Node's fetch (undici) doesn't reliably surface a
    // 304 for a conditional request the way a real browser/curl does —
    // same class of measurement gap hit earlier with gzip sizing.
    await fetch(`${server.baseUrl}/en`);
    const warm = await fetch(`${server.baseUrl}/en`);
    const etag = warm.headers.get("etag");
    expect(etag, "expected an ETag on the locale shell response").toBeTruthy();

    const { stdout } = await execFileAsync("curl", [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-H",
      `If-None-Match: ${etag}`,
      `${server.baseUrl}/en`,
    ]);
    expect(stdout.trim()).toBe("304");
  });

  it("forbids any shared cache from storing the service worker script", async () => {
    // Not a style preference -- this exact header caused a real outage on
    // 2026-08-21. A worker enforces the CSP served on its own script,
    // captured at install. That CSP is derived from NEXT_PUBLIC_API_URL,
    // so moving the API changed it while sw.js's bytes stayed identical.
    // Under the old `public, max-age=0`, Cloudflare stored the response,
    // revalidated to a 304, and kept its STORED headers -- serving a CSP
    // naming the retired API host. Every worker installed from that copy
    // blocked every API call, and identical bytes meant browsers never
    // installed a replacement.
    //
    // `no-cache` is NOT sufficient and must not be substituted: it permits
    // storing and revalidating, which is precisely the path that preserved
    // the stale header. Only `no-store` keeps headers from outliving the
    // build that produced them.
    const res = await fetch(`${server.baseUrl}/sw.js`);
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-store");
  });

  it("serves the worker script with a CSP naming the configured API origin", async () => {
    // The coupling that made the outage possible, pinned so it is visible:
    // this script's response carries a CSP, and that CSP is what the worker
    // will enforce for its own fetches. If the API origin and this header
    // ever disagree, every request the worker makes is blocked -- silently,
    // since a blocked worker fetch surfaces as a dead request rather than a
    // CSP violation the page can see.
    const res = await fetch(`${server.baseUrl}/sw.js`);
    const csp = res.headers.get("content-security-policy") ?? "";

    // Parsed out of the policy rather than substring-matched against the
    // whole header. Checking "contains connect-src" AND "contains origin"
    // independently passes on `connect-src 'none'; default-src <origin>`
    // -- a policy that blocks every request the worker makes. The two
    // facts have to be one fact.
    const connectSrc = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("connect-src "));
    expect(connectSrc, "expected a connect-src directive on /sw.js").toBeDefined();

    const apiOrigin = new URL(
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql",
    ).origin;
    // A complete source expression, not a substring: `https://api.example`
    // must not be satisfied by `https://api.example.evil.test`.
    const sources = connectSrc!.split(/\s+/).slice(1);
    expect(sources).toContain(apiOrigin);
  });
});
