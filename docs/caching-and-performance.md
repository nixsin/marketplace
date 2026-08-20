# Caching & performance

> Infrastructure-level caching (CDN, edge, object storage) is documented
> separately in [infrastructure.md](./infrastructure.md).


How the shell, product data, and build output stay fast and cacheable. For the broader caching/CDN roadmap (not yet built), see [issue #78](https://github.com/nixsin/marketplace/issues/78).

## Shell vs. item data — split on purpose, not by accident

`apps/web/src/app/[locale]/page.tsx` no longer fetches product data itself. Items for sale are fetched by `apps/web/src/components/product-listing.tsx`, a Client Component that calls the GraphQL API directly on mount and again whenever `?page` changes. Two reasons this split exists:

1. **Product data is genuinely dynamic** (new listings, edited descriptions/prices) and must never be treated as safe to cache alongside the shell — every load needs current DB state.
2. **The shell has no such requirement.** Splitting its data-fetching out entirely is what lets `/en` and `/hi` go back to being genuinely static, prerendered routes (confirmed via `x-nextjs-prerender: 1` and `x-nextjs-cache: HIT` — real headers, checked in `test/static-caching.spec.ts`, not assumed). A repeat visit with the same locale gets a `304 Not Modified` on the shell instead of a full re-render — no server-side work, negligible transfer, without needing a Service Worker.

**Known remaining gap**: a hard page reload still costs one small conditional-GET round trip for the shell document itself (the 304 above) — that's normal, correct HTTP behavior, not a bug, but it isn't literally zero network activity. Closing that last gap needed a Service Worker serving the shell from Cache Storage — since built, see `apps/web/public/sw.js` and [issue #78](https://github.com/nixsin/marketplace/issues/78) §3.6.

## Product data caching (GraphQL-over-GET)

The first version of this shell/data split only solved half the problem: `product-listing.tsx` still fetched via **POST**, which HTTP defines as non-cacheable regardless of any headers set — no ETag or `Cache-Control` on a POST response can make a browser or CDN reuse it. `apps/web/src/lib/api.ts`'s `fetchProductsPaged` now sends the same GraphQL query as **GET** instead (query + variables URL-encoded, per the GraphQL-over-HTTP spec — the same approach GitHub's and Shopify's GraphQL APIs use for CDN-cacheable reads), with the `apollo-require-preflight` header Apollo Server's CSRF protection requires on GET.

- `apps/api/src/app.setup.ts` — shared between `main.ts` and the e2e tests (previously two copies of bootstrap config existed and could drift) — overrides Apollo's default `Cache-Control: no-store` to `public, max-age=0, must-revalidate` **specifically for GET requests to `/graphql`**, so the real ETag Apollo already computes can actually be used for conditional revalidation. POST stays untouched (`no-store`, confirmed in `test/products.e2e-spec.ts`) — mutations and anything sent via POST must never be treated as cacheable.
- Verified with real browser Resource Timing data (not just curl): a reload shows `transferSize: 300` bytes against an actual `encodedBodySize` of ~2.5KB for the product data — the same 304 signature as the shell, confirming the browser is genuinely reusing cached product data rather than re-fetching it. Cross-origin Resource Timing values are zeroed by browsers for privacy by default; `Timing-Allow-Origin` is set explicitly so this is actually measurable, not just inferred.
- Mutations (`requestOtp`, `completeOnboarding`, etc.) and any exploratory queries sent via POST are deliberately unaffected — this override only ever applies to GET.

Caching this response at the service-worker layer required real care: Cache Storage matches by request, not by caller identity, so a naive "cache every GET to `/graphql`" rule would risk serving one user's authenticated response to another. `apps/web/public/sw.js` allowlists the exact canonical query text and independently checks both `credentials` and the `Authorization` header before caching — see [issue #78](https://github.com/nixsin/marketplace/issues/78) §3.6 and `apps/web/e2e/sw-cache-isolation.spec.ts` for the full reasoning and test coverage.

## Minification & debugging prod

Standard industry split: dev is unminified for debugging; prod is minified for real users, with source maps as the mechanism to debug prod without shipping unminified code.

| | Dev | Prod |
|---|---|---|
| Web JS/CSS | Unminified (`next dev` default) | Minified + source maps (`productionBrowserSourceMaps: true` in `next.config.ts`) |
| API (NestJS) | Runs TS directly via ts-node | Compiled JS (not minified — see below) + source maps (`node --enable-source-maps`, `start:prod`) |
| GraphQL query text | N/A | Minified once at module load (`minifyGql` in `lib/api.ts`) — it travels in a URL (GraphQL-over-GET), where whitespace costs real bytes and costs *more* once percent-encoded |

- **Why the API isn't minified**: minification's entire benefit is reducing bytes a browser downloads. Backend code never leaves the server, so minifying it buys nothing and only makes prod stack traces harder to read. Source maps, not minification, are the right lever for a Node backend.
- **Source maps are opt-in for DevTools, not a page-weight cost** — browsers only fetch a `.map` file when DevTools is actually open and requests it. Regular users loading the page never download them.
- **Public source maps were a deliberate choice**, not an oversight — they can reveal original source structure to anyone who requests the `.map` file directly. Fine for this codebase today; revisit (upload to an error-tracking service instead of serving `.map` files publicly) once there's real business logic worth keeping private. Changing that later doesn't require touching the build pipeline, just where the maps end up.
- Removed `source-map-support` from the API's dependencies — it was listed (leftover from the original `nest new` scaffold) but never actually imported anywhere, so source maps were being generated but never used. Node's own `--enable-source-maps` (stable since Node 18) replaces it.

## Security headers

`next.config.ts`'s `headers()` sets a Content-Security-Policy, HSTS (production only — see `apps/web/src/lib/security-headers.ts`'s own comments for why dev must never get an HSTS header), `X-Frame-Options: DENY`, and `Cross-Origin-Opener-Policy: same-origin` on every real page/document response — deliberately scoped to exclude `/_next/static/*` and `/_next/image`, which don't need or benefit from document-level security headers. The header-value computation is pure, unit-tested logic in `security-headers.ts` (`security-headers.spec.ts`), since `next.config.ts` itself can't be imported and exercised by a normal test.
