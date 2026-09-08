import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * How Next classified each route, read from Next's own record of it.
 *
 * Lives in apps/web/test/ rather than beside the route's unit specs, and that
 * placement is the point: every spec in this directory requires a production
 * build, and build-freshness.spec.ts already enforces both halves of that --
 * that a build exists at all, and that it is newer than everything under
 * src/, next.config.ts and package.json. A build-dependent assertion sitting
 * in src/ would instead make those unit specs unrunnable on a clean checkout,
 * which is what an earlier version of this did.
 *
 * Why the assertion is worth having: the route's own exports (`revalidate`,
 * `generateStaticParams`) are necessary and NOT sufficient. A request-time
 * API anywhere in the route's tree -- a dependency, a boundary file,
 * something next-intl reaches for internally -- silently reverts the route to
 * Dynamic while every export-level test still passes. That is not
 * hypothetical: `not-found.tsx` did exactly that, through a getTranslations()
 * call that had no locale to work from and so fell back to headers().
 *
 * The consequence of the regression is entirely invisible in development,
 * where pages are always rendered on demand: the route ships
 * `private, no-cache, no-store`, Cloudflare's respect_origin rule declines
 * it, and every product page silently goes back to a full origin round trip.
 */
const PRERENDERABLE_ROUTES = ["/[locale]/products/[id]"];

describe("route classification", () => {
  const manifestPath = join(process.cwd(), ".next", "prerender-manifest.json");

  it("has a prerender manifest to read", () => {
    expect(
      existsSync(manifestPath),
      "No production build found. Run `pnpm --filter web build` -- this " +
        "directory's specs read real build output.",
    ).toBe(true);
  });

  it("classifies the product page as prerenderable, not Dynamic", () => {
    if (!existsSync(manifestPath)) return; // already reported above
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dynamicRoutes?: Record<string, unknown>;
    };

    // A Dynamic route is absent from `dynamicRoutes` entirely -- verified by
    // building this route both ways rather than assumed. Before the ISR
    // change this object was `{}`.
    for (const route of PRERENDERABLE_ROUTES) {
      expect(
        Object.keys(manifest.dynamicRoutes ?? {}),
        `${route} is missing from prerender-manifest.dynamicRoutes, which ` +
          "means Next classified it as Dynamic. It will ship `no-store` and " +
          "the CDN will decline it. Something in that route's tree is using " +
          "a request-time API -- `next build --debug-prerender` names it.",
      ).toContain(route);
    }
  });
});
