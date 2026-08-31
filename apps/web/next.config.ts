import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { buildCspHeader, hstsHeaderEntries } from "./src/lib/security-headers";
import { siteUrlErrorMessage, siteUrlProblem } from "./src/lib/site-url";
import {
  assertEnvOrExit,
  isRenderDeploy,
} from "@medinstru/config/env-contract";
import { API_URL, SITE_URL } from "@medinstru/config/web";
import {
  CROSS_ORIGIN_OPENER_POLICY,
  FAVICON_MAX_AGE_SECONDS,
  FRAME_OPTIONS,
  LOCALES,
  publicCacheControl,
  SERVICE_WORKER_CACHE_CONTROL,
  CONTENT_TYPE_OPTIONS,
  REFERRER_POLICY,
  PERMISSIONS_POLICY,
} from "@medinstru/config";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const isDev = process.env.NODE_ENV === "development";

// The single value apps/web needs from the blob-storage domain: the origin
// browsers fetch images from. Read directly rather than via
// @medinstru/config, because apps/api owns the rest of that configuration
// (provider table, endpoints, credentials) and there is no derived logic
// here for the two to drift apart on -- just one env var, read once.
const BLOB_BASE_URL = process.env.NEXT_PUBLIC_BLOB_BASE_URL ?? "";

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
// API_URL and SITE_URL come from @medinstru/config/web, NOT from
// process.env. That import is what makes this file fail fast: the subpath
// throws when either variable is unset, and Next transpiles and loads
// next.config.ts at container BOOT as well as at build -- so a misconfigured
// deploy never binds a port, Render marks it failed, and the previous healthy
// version stays live.
//
// Reading process.env here instead would defer the failure to whichever page
// first rendered, which is a 500 per request rather than a refused deploy.
const cspHeader = buildCspHeader({
  isDev,
  siteUrl: SITE_URL,
  apiUrl: API_URL,
  blobBaseUrl: BLOB_BASE_URL,
});

// Derived from @medinstru/config's own LOCALES rather than hardcoded a
// second time here -- a previously-separate "/(en|hi)" literal would
// silently leave a new locale without this route's Cache-Control fix (no
// test or type error would catch the mismatch, since Next.js header
// `source` patterns are just strings).
const localeRoutePattern = `/(${LOCALES.join("|")})`;

/**
 * next/image remote host allowlist for the blob store.
 *
 * Empty when no blob base URL is configured, which is the current state --
 * images are served from this origin and need no entry at all. An
 * unparseable value also yields an empty list, so a bad env var means
 * "no remote images allowed" rather than a crash while loading the config
 * (which, per CLAUDE.md's outage notes, takes the whole container down at
 * boot rather than degrading).
 */
function blobRemotePatterns(baseUrl: string) {
  if (!baseUrl) return [];
  try {
    const { protocol, hostname } = new URL(baseUrl);
    return [
      {
        protocol: protocol.replace(":", "") as "http" | "https",
        hostname,
      },
    ];
  } catch {
    return [];
  }
}

// A Render build (RENDER_GIT_COMMIT is only set there) must not resolve
// SITE_URL to the local development default. This shipped once: the
// deployed service never had NEXT_PUBLIC_SITE_URL set, so every WhatsApp
// share link pointed at http://localhost:3000 and og:image pointed at
// http://localhost:3000/products/*.svg -- a dead link and a broken preview
// card, in the one feature whose entire job is being forwarded to someone
// else. render.yaml declares the right value but is documentation-only,
// not an active Blueprint sync, so nothing enforced it.
//
// Failing the build is deliberate. NEXT_PUBLIC_* is inlined at build time,
// so a wrong value cannot be corrected at runtime -- by the time anyone
// notices, the artifact is already wrong. Better to refuse to produce it.
//
// The rule itself lives in src/lib/site-url.ts, unit tested, for the same
// reason security-headers.ts was extracted: next.config.ts is the file
// Next.js loads to boot and cannot be imported by an ordinary test, and
// logic that decides whether a deploy may proceed should not be the one
// part of the codebase verified only by hand. It rejects more than just
// an unset value -- a present-but-wrong one (leftover localhost, stray
// paste, whitespace) produces identical dead links while satisfying a
// guard that only checks for absence.
// Runs at BUILD and at every container BOOT. Next transpiles and loads this
// file at container start, not only during `next build` (visible in a crash
// stack as next-config-ts/transpile-config.js) -- which is why this is the
// hook, and why a `prestart` npm script would not be: the prod image's CMD is
// `node_modules/.bin/next start`, so npm lifecycle hooks never run there.
//
// Checked first and separately from the sweep below, because these two are
// inlined into the client bundle at build time and cannot be corrected at
// runtime, and because siteUrlProblem produces a far better message than a
// generic presence check -- it covers private ranges, CGNAT, IPv4-mapped
// IPv6, embedded credentials and trailing dots, and never echoes the raw
// value into a build log.
//
// NEXT_PUBLIC_API_URL is checked with the same function as
// NEXT_PUBLIC_SITE_URL. It was previously unguarded, which was the larger
// hole of the two: it is the origin every visitor's browser fetches products
// from AND the value connect-src is derived from, so a bad one misdirects
// and blocks at the same time.
if (isRenderDeploy()) {
  for (const [name, value] of [
    ["NEXT_PUBLIC_SITE_URL", process.env.NEXT_PUBLIC_SITE_URL],
    ["NEXT_PUBLIC_API_URL", process.env.NEXT_PUBLIC_API_URL],
  ] as const) {
    const problem = siteUrlProblem(value);
    if (problem) throw new Error(`${name}: ${siteUrlErrorMessage(problem)}`);
  }
}

// Everything else this app reads, reported in one pass rather than one
// failure at a time. Exits non-zero on a real problem, so a misconfigured
// deploy never binds a port and Render keeps the previous healthy version
// live -- strictly better than serving a broken site with a 200.
assertEnvOrExit({ app: "web" });

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
    // next/image refuses any remote host not listed here, so a blob-backed
    // image would 400 without this. Derived from the same configured value
    // the CSP uses, so the two cannot drift into a state where one allows
    // the host and the other blocks it -- a failure that presents as
    // "images work locally, break in production".
    //
    // Scoped to the exact hostname and protocol rather than a wildcard:
    // this list is what stops the image optimiser being used as an open
    // proxy for arbitrary remote URLs.
      remotePatterns: blobRemotePatterns(BLOB_BASE_URL),
  },
  async headers() {
    return [
      {
        // Build identity on every response, readable with `curl -I`. This
        // exists because of a real deploy-skew incident (2026-08-19): four
        // PRs merged in quick succession, Render deployed each service
        // independently, and the web app went live calling a `product(id)`
        // query the API had not deployed yet -- every detail page 500'd,
        // and nothing either service exposed made the mismatch visible.
        //
        // A response header rather than a <meta> tag deliberately: the meta
        // route depends on Next's metadata pipeline and, when tried, the
        // values landed in the prerendered .html on disk but did not appear
        // in the served response. A header is emitted by next.config.ts
        // itself, is trivially greppable, and needs no HTML parsing.
        //
        // Read from the environment at RUNTIME, not inlined at build: the
        // prod stage persists these as ENV, so what the header reports is
        // what the running container actually is.
        // `/(.*)` rather than `/:path*`: the latter is in the manifest but
        // is not applied to real responses, while this style is proven by
        // the security-headers block below. Verified by inspecting the
        // shipped image's routes-manifest.json (entry present, correct
        // values) against a real curl (header absent).
        source: "/(.*)",
        headers: [
          { key: "X-Build-Commit", value: process.env.BUILD_COMMIT || "unknown" },
          { key: "X-Build-Time", value: process.env.BUILD_TIME || "unknown" },
        ],
      },
      {
        // Not content-hashed (fixed URL), so unlike /_next/static/* this
        // can't be `immutable` — a real favicon update needs to be visible
        // within a day, not cached forever. Still a real improvement over
        // the previous default of effectively no caching (found via the
        // cold vs. warm Lighthouse comparison — this was the one asset
        // still re-downloaded on every repeat visit).
        source: "/favicon.ico",
        headers: [
          {
            key: "Cache-Control",
            value: `public, max-age=${FAVICON_MAX_AGE_SECONDS}`,
          },
        ],
      },
      {
        // The service worker script must NEVER be held by a shared cache,
        // and `no-store` rather than `no-cache` is deliberate.
        //
        // A worker enforces the CSP served on THIS response, captured at
        // install time. That CSP is derived from NEXT_PUBLIC_API_URL, so
        // it changes on an API move -- while sw.js's own bytes do not.
        // The previous `public, max-age=0` let Cloudflare store it, and a
        // 304 revalidation then kept the STORED HEADERS: the edge kept
        // serving a CSP naming the retired API host long after the origin
        // had stopped sending it. Every worker installed from that copy
        // hard-failed every API call.
        //
        // `no-cache` would not have helped -- it permits storing and
        // revalidating, which is exactly the path that preserved the
        // stale header. `no-store` forbids keeping a copy at all, so the
        // headers can never outlive the build that produced them.
        //
        // Cost is one small uncached request per navigation, which
        // browsers already special-case for worker scripts anyway.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: SERVICE_WORKER_CACHE_CONTROL },
        ],
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
            // s-maxage + stale-while-revalidate, matching the API's own
            // policy (apps/api/src/graphql-cache.ts explains the split).
            //
            // The first product page is now server-rendered from a 60-second
            // revalidated snapshot so crawlers receive real links. The HTML
            // remains publicly cacheable at the edge under this matching
            // policy instead of making every visitor pay for that render.
            //
            // max-age=0 still keeps the browser revalidating, so a deploy
            // is picked up on the next navigation. s-maxage only affects
            // shared caches, and takes effect once the apex is proxied
            // through Cloudflare (see docs/cloudflare.md §5.3).
            // Same policy the API sends on cacheable GraphQL GETs --
            // one definition, in @medinstru/config, rather than this
            // string and apps/api's constants drifting apart.
            value: publicCacheControl(),
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
          { key: "X-Frame-Options", value: FRAME_OPTIONS },
          { key: "Cross-Origin-Opener-Policy", value: CROSS_ORIGIN_OPENER_POLICY },
          // The three below were absent entirely -- not deliberate gaps like
          // HSTS preload and Trusted Types, which docs/security-headers.md
          // records with reasons. These had zero mentions anywhere in the
          // repo, found by a live CDN audit rather than by reading the code.
          { key: "X-Content-Type-Options", value: CONTENT_TYPE_OPTIONS },
          { key: "Referrer-Policy", value: REFERRER_POLICY },
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
