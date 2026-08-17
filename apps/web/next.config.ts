import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const isDev = process.env.NODE_ENV === "development";

// Same origin the app actually calls for GraphQL (see src/lib/api.ts's
// identical fallback) -- derived from the same env var so connect-src
// tracks whatever API this build is really pointed at (local API in dev,
// medinstru-api.onrender.com in prod per render.yaml) instead of a
// hardcoded prod-only domain that would break CSP locally.
const apiOrigin = new URL(
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql",
).origin;

// Nonce-based CSP (Next's own stricter recommended option) requires every
// page to render dynamically -- Next can only inject a nonce during SSR, so
// a page prerendered at build time has nowhere to put it. That's a direct
// conflict with this repo's existing, deliberate architecture:
// product-listing.tsx keeps the page shell statically prerenderable
// specifically so it stays browser-cacheable (see its own comment, and the
// Cache-Control block below) and fetches product data client-side for
// exactly that reason. The static, no-nonce CSP form below (Next's own
// documented "Without Nonces" pattern) keeps that intact, at the cost of
// 'unsafe-inline' for script/style -- needed for Next's inline hydration
// scripts and the inline `style` attributes React/next-image both emit.
// Still real protection against what CSP's other directives cover
// (external script injection, clickjacking via frame-ancestors, mixed
// content, base/form-action hijacking) -- just not full inline-script XSS
// mitigation. Revisit with nonces if this app later needs dynamic
// rendering anyway (e.g. a real auth-gated page).
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:;
  font-src 'self';
  connect-src 'self' ${apiOrigin};
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';${isDev ? "" : " upgrade-insecure-requests;"}
`
  .replace(/\s{2,}/g, " ")
  .trim();

// `preload` deliberately omitted -- it means submitting this domain to
// browsers' hardcoded HSTS preload lists, which is effectively
// irreversible. Add it later once this has been confirmed stable in
// production for a while.
const hstsHeaderValue = "max-age=63072000; includeSubDomains";

const nextConfig: NextConfig = {
  // Ships .map files alongside minified prod JS — DevTools loads them only
  // when actually opened, so this costs nothing for normal page loads.
  // Public (not restricted to authenticated/internal access) is a
  // deliberate choice for now, not an oversight — revisit once there's
  // real business logic worth keeping out of a public source map.
  productionBrowserSourceMaps: true,
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
        source: "/(en|hi)",
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
          { key: "Strict-Transport-Security", value: hstsHeaderValue },
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
