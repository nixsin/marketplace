import { describe, expect, it } from "vitest";
import {
  buildCspHeader,
  computeApiOrigin,
  HSTS_HEADER_VALUE,
  hstsHeaderEntries,
} from "./security-headers";

describe("computeApiOrigin", () => {
  it("derives just the origin from a full GraphQL endpoint URL", () => {
    expect(computeApiOrigin("https://medinstru-api.onrender.com/graphql")).toBe(
      "https://medinstru-api.onrender.com",
    );
  });

  it("falls back to the local API origin when no URL is given", () => {
    // Matches src/lib/api.ts's own identical fallback -- this is the value
    // that must stay in sync so CSP's connect-src always allows whatever
    // the app itself is actually configured to fetch.
    expect(computeApiOrigin(undefined)).toBe("http://localhost:4000");
  });
});

describe("buildCspHeader", () => {
  it("includes 'unsafe-eval' and omits upgrade-insecure-requests in dev", () => {
    // React's dev-mode error reconstruction needs eval() -- Next's own
    // documented reasoning for this exact exception. upgrade-insecure-
    // requests is omitted because it would force a local API's plain-http
    // connect-src origin to https, breaking local dev against a plain
    // local API server.
    const csp = buildCspHeader({
      isDev: true,
      apiUrl: "http://localhost:4000/graphql",
    });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("omits 'unsafe-eval' and includes upgrade-insecure-requests in production", () => {
    const csp = buildCspHeader({
      isDev: false,
      apiUrl: "https://medinstru-api.onrender.com/graphql",
    });
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("scopes connect-src to 'self' plus exactly the given API's origin", () => {
    const csp = buildCspHeader({
      isDev: false,
      apiUrl: "https://medinstru-api.onrender.com/graphql",
    });
    expect(csp).toContain(
      "connect-src 'self' https://medinstru-api.onrender.com;",
    );
  });

  it("always requires 'unsafe-inline' for script-src and style-src", () => {
    // The documented trade-off (see next.config.ts's own comment) for
    // staying on the static, no-nonce CSP form -- Next's inline hydration
    // scripts and next/image's inline style attributes need this
    // regardless of environment. A silent drop of either would either
    // break the app (script-src) or just stop protecting against
    // injected <style> (style-src) -- neither should happen unnoticed.
    const csp = buildCspHeader({ isDev: false, apiUrl: undefined });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("always sets frame-ancestors 'none' and object-src 'none'", () => {
    const cspDev = buildCspHeader({ isDev: true, apiUrl: undefined });
    const cspProd = buildCspHeader({ isDev: false, apiUrl: undefined });
    for (const csp of [cspDev, cspProd]) {
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });
});

describe("HSTS_HEADER_VALUE", () => {
  it("sets a long max-age and includeSubDomains, but never preload", () => {
    // `preload` is the one directive this repo deliberately withholds --
    // submitting to browsers' hardcoded preload lists is effectively
    // irreversible, so a silent addition here would be a real, hard-to-
    // undo mistake, not just a config drift.
    expect(HSTS_HEADER_VALUE).toContain("includeSubDomains");
    expect(HSTS_HEADER_VALUE).not.toContain("preload");
    expect(HSTS_HEADER_VALUE).toMatch(/max-age=\d+/);
  });
});

describe("hstsHeaderEntries", () => {
  it("emits nothing in dev", () => {
    // A browser persists HSTS per hostname for the full max-age the
    // moment it sees the header even once, then refuses plain HTTP to
    // that host until it expires -- genuinely disruptive for a local dev
    // server ever accessed over HTTPS, not just a theoretical mismatch.
    // An AI review caught that this was previously emitted unconditionally.
    expect(hstsHeaderEntries(true)).toEqual([]);
  });

  it("emits the Strict-Transport-Security header in production", () => {
    expect(hstsHeaderEntries(false)).toEqual([
      { key: "Strict-Transport-Security", value: HSTS_HEADER_VALUE },
    ]);
  });
});

describe("blob image host in CSP", () => {
  it("adds no img-src entry when no blob host is configured", () => {
    // Today's state. The policy must stay exactly as tight as it is now
    // until a provider is actually switched on.
    const csp = buildCspHeader({ isDev: false, apiUrl: undefined });
    expect(csp).toContain("img-src 'self' blob: data:;");
  });

  it("allows the blob host once configured", () => {
    const csp = buildCspHeader({
      isDev: false,
      apiUrl: undefined,
      blobBaseUrl: "https://images.laxair.shop",
    });
    expect(csp).toContain("img-src 'self' blob: data: https://images.laxair.shop;");
  });

  it("allows only the origin, never a path", () => {
    // A CSP source carrying a path is matched by PREFIX, which permits
    // more than it reads like it does -- a classic way to write a policy
    // that looks tight and is not.
    const csp = buildCspHeader({
      isDev: false,
      apiUrl: undefined,
      blobBaseUrl: "https://images.laxair.shop/bucket/media",
    });
    expect(csp).toContain("data: https://images.laxair.shop;");
    expect(csp).not.toContain("/bucket/media");
  });

  it("falls back to a stricter policy on an unparseable value", () => {
    // A bad env var must degrade to stricter, never to broken.
    const csp = buildCspHeader({
      isDev: false,
      apiUrl: undefined,
      blobBaseUrl: "not a url",
    });
    expect(csp).toContain("img-src 'self' blob: data:;");
  });
});

