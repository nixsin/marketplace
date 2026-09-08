import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@medinstru/config";

// next-intl/middleware reaches for next/server, which does not resolve under
// vitest. Only the factory is stubbed -- `config` below is still the real
// exported object, so this asserts the matcher Next actually loads rather
// than a copy of it.
vi.mock("next-intl/middleware", () => ({ default: () => () => undefined }));

const { config } = await import("./proxy");

/**
 * What the locale middleware is allowed to touch.
 *
 * This matcher decides which paths get answered with a locale redirect, and
 * getting it wrong is silent in both directions: too narrow and a page stops
 * being localised, too wide and a non-page route is redirected somewhere that
 * does not exist. The second one shipped -- `/sitemaps/0` was answered with a
 * 307 to `/en/sitemaps/0`, which 404s, so the sitemap index returned 200 with
 * every link inside it dead.
 *
 * Asserted against the real exported string rather than a copy, because a
 * matcher that drifts from the one Next actually loads tests nothing.
 */
const matcher = new RegExp(`^${config.matcher[0]}$`);
const negotiates = (path: string) => matcher.test(path);

describe("proxy matcher", () => {
  it("EXCLUDES sitemap shards, which are not pages", () => {
    // The regression. app/sitemaps/[id]/route.ts sits outside [locale], so a
    // locale redirect sends crawlers to a route that does not exist.
    expect(negotiates("/sitemaps/0")).toBe(false);
    expect(negotiates("/sitemaps/12")).toBe(false);
  });

  it("still excludes the sitemap index, which a dot already covered", () => {
    // This one was never broken, and that is precisely why the shards went
    // unnoticed -- the entry point looked healthy.
    expect(negotiates("/sitemap.xml")).toBe(false);
  });

  it("does not over-match a path that merely starts with the same letters", () => {
    // Why the exclusion is written `sitemaps/` and not bare `sitemaps`: the
    // lookahead is a prefix test, so the bare form would silently stop
    // localising any future /sitemapsomething page.
    expect(negotiates("/sitemapsomething")).toBe(true);
  });

  it("STILL negotiates ordinary pages", () => {
    // The other direction. Narrowing this matcher until a real page stops
    // being localised is the failure this half guards against.
    for (const path of ["/", "/products", "/about"]) {
      expect(negotiates(path)).toBe(true);
    }
  });

  it("still handles already-localised paths", () => {
    // These reach the middleware and are passed through rather than
    // redirected; excluding them would break locale detection entirely.
    for (const locale of LOCALES) {
      expect(negotiates(`/${locale}`)).toBe(true);
      expect(negotiates(`/${locale}/products/abc`)).toBe(true);
    }
  });

  it("excludes Next internals, API routes and anything with a file extension", () => {
    for (const path of [
      "/api/health",
      "/_next/static/chunk.js",
      "/_vercel/insights",
      "/favicon.ico",
      "/robots.txt",
      "/sw.js",
    ]) {
      expect(negotiates(path)).toBe(false);
    }
  });
});
