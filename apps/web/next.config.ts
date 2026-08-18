import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Ships .map files alongside minified prod JS — DevTools loads them only
  // when actually opened, so this costs nothing for normal page loads.
  // Public (not restricted to authenticated/internal access) is a
  // deliberate choice for now, not an oversight — revisit once there's
  // real business logic worth keeping out of a public source map.
  productionBrowserSourceMaps: true,
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
        source: "/(en|hi)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
