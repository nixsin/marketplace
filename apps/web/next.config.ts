import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { buildCspHeader, hstsHeaderEntries } from "./src/lib/security-headers";
import { LOCALES } from "@medinstru/config";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const isDev = process.env.NODE_ENV === "development";

// The actual header-value computation lives in src/lib/security-headers.ts,
// as plain, unit-tested functions (src/lib/security-headers.spec.ts) --
// pulled out specifically because an AI review on the PR that introduced
// this flagged that the manual verification documented in CLAUDE.md isn't
// repeatable regression coverage for security-critical, environment-
// dependent logic. next.config.ts itself can't easily be imported and
// exercised by a test the normal way (it's the thing Next.js itself loads
// to boot), so this file now only wires the computed values into
// `headers()` -- see CLAUDE.md's "Security headers" section for the full
// reasoning behind each directive (nonce-vs-static CSP tradeoff, why
// connect-src is derived from NEXT_PUBLIC_API_URL, why
// upgrade-insecure-requests and 'unsafe-eval' are environment-gated, why
// HSTS omits preload, why Trusted Types is a deliberate, documented gap).
const cspHeader = buildCspHeader({
  isDev,
  apiUrl: process.env.NEXT_PUBLIC_API_URL,
});

// Derived from @medinstru/config's own LOCALES rather than hardcoded a
// second time here -- a previously-separate "/(en|hi)" literal would
// silently leave a new locale without this route's Cache-Control fix (no
// test or type error would catch the mismatch, since Next.js header
// `source` patterns are just strings).
const localeRoutePattern = `/(${LOCALES.join("|")})`;

const nextConfig: NextConfig = {
  // Ships .map files alongside minified prod JS — DevTools loads them only
  // when actually opened, so this costs nothing for normal page loads.
  // Public (not restricted to authenticated/internal access) is a
  // deliberate choice for now, not an oversight — revisit once there's
  // real business logic worth keeping out of a public source map.
  productionBrowserSourceMaps: true,
  experimental: {
    // Lighthouse's render-blocking-insight audit flagged the compiled
    // Tailwind stylesheet (a single <link>, ~9KB) as render-blocking with
    // a real (non-zero) LCP cost -- confirmed directly via a local
    // Lighthouse run's own audit output, not assumed. This is the exact
    // documented use case for this flag (atomic CSS, small per-route
    // bundle, first-time visitors) per Next's own docs, which explicitly
    // recommend it for a Tailwind setup like this one. Inlines the
    // stylesheet into <style> in <head> instead of a separate <link>,
    // removing that request from the critical path entirely. Trade-off
    // (per the docs): returning visitors lose the ability to cache CSS
    // separately from the HTML document -- accepted here since the CSS
    // bundle is small and LCP for first-time visitors is what's actually
    // budget-gated. Experimental and prod-build-only (no effect in dev).
    inlineCss: true,
  },
  // Version-skew protection: Render exposes RENDER_GIT_COMMIT at build
  // time (confirmed via Render's own docs), and the Dockerfile passes it
  // through as a build ARG the same way NEXT_PUBLIC_API_URL already is --
  // without that, this would silently compile to undefined regardless of
  // what's set at container runtime, since deploymentId is baked into the
  // build output, not read live. Empty string (local builds with no
  // --build-arg) becomes undefined here rather than a literal "" value,
  // which cleanly disables the feature locally instead of passing Next a
  // value that looks configured but isn't. See #78 §3.3 for what this
  // actually catches (a stale tab detecting a new deploy) and its real
  // limits (doesn't reach a tab that never navigates again; interaction
  // with the service worker's own stale-while-revalidate on navigations
  // is unverified against a real two-deployment test).
  deploymentId: process.env.RENDER_GIT_COMMIT || undefined,
  images: {
    // Only for the self-authored, static SVGs under /public/products — not
    // for any user/seller-uploaded content, which is exactly what this
    // flag is unsafe for (SVGs can carry scripts). CSP below sandboxes
    // served SVGs so even these can't execute anything, per Next's own
    // recommended config for this flag.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  async headers() {
    return [
      {
        // Not content-hashed (fixed URL), so unlike /_next/static/* this
        // can't be `immutable` — a real favicon update needs to be visible
        // within a day, not cached forever. Still a real improvement over
        // the previous default of effectively no caching (found via the
        // cold vs. warm Lighthouse comparison — this was the one asset
        // still re-downloaded on every repeat visit).
        source: "/favicon.ico",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
      {
        // Next.js's default Cache-Control on this static/SSG route is
        // `s-maxage=31536000` — a *shared-cache* (CDN) directive only.
        // Without `public`/`max-age` here, the browser's own private
        // cache doesn't reliably store or revalidate the response, so a
        // real page reload was issuing a plain fresh GET every time
        // (the server answered fast from its own cache, but the browser
        // never got to skip the round trip). `max-age=0, must-revalidate`
        // makes the browser always send a conditional request (using the
        // ETag Next.js already sets) on reuse, and only actually
        // transfer/re-render the page if the ETag no longer matches.
        source: localeRoutePattern,
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
      {
        // Scoped to actual page/document responses -- NOT literally global
        // despite covering every real route (`/(.*)` would also match
        // every /_next/static/* chunk and /_next/image request). That
        // first version shipped and was caught live: `headers()` applies
        // before the filesystem, per Next's own docs, so those headers
        // rode along on every JS chunk response too -- real, deterministic
        // bytes (confirmed identical across all 10 perf-budget.mjs runs on
        // one CI run, not noise), pushing the JS transfer budget over by
        // ~1.4KB for zero actual security benefit: CSP/HSTS/XFO/COOP only
        // matter on the document that establishes them, not on each
        // sub-resource's own response, and /_next/image already carries
        // its own narrower, purpose-built CSP via `images.contentSecurityPolicy`
        // above. Excludes `_next` broadly (not just `_next/static`) and
        // the favicon (own scoped block above) -- same negative-lookahead
        // style `src/proxy.ts`'s own matcher already uses in this repo,
        // confirmed to work the same way here (both compile through
        // Next's identical path-to-regexp matcher).
        //
        // `require-trusted-types-for 'script'` (flagged by Lighthouse's
        // best-practices audit) is deliberately NOT included here: it
        // needs a policy name Next's own internals are confirmed to
        // register under, and getting that wrong fails silently (a
        // blocked DOM write, not a loud error) -- not verified in this
        // pass, so left as a known, documented gap rather than shipped
        // unverified. Revisit if this is ever actually confirmed against
        // a real Next.js Trusted Types policy name for this version.
        source: "/((?!_next|favicon\\.ico).*)",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          // Emitted in production only -- see hstsHeaderEntries's own
          // comment for why this must be a gated function, not the plain
          // constant unconditionally spread in here.
          ...hstsHeaderEntries(isDev),
          // Belt-and-suspenders with the CSP frame-ancestors directive
          // above: browsers that don't honor frame-ancestors still fall
          // back to this. No legitimate embedding use case exists for
          // this marketplace site.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
