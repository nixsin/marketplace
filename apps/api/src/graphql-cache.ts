/**
 * Cache-Control for cacheable GraphQL GET responses.
 *
 * THREE DIRECTIVES, THREE DIFFERENT AUDIENCES. Getting these confused is
 * the usual way this goes wrong, so they are spelled out:
 *
 *   max-age=0                 the BROWSER's private cache. Zero, so a
 *                             reload always revalidates and a user never
 *                             sees a stale catalogue they cannot refresh.
 *
 *   s-maxage=N                SHARED caches only (a CDN). Overrides
 *                             max-age for them. This is what lets an edge
 *                             node serve a product listing without a
 *                             round trip to the origin.
 *
 *   stale-while-revalidate=M  serve the stale copy IMMEDIATELY and
 *                             refresh in the background. Honoured by
 *                             browsers as well as CDNs, which matters --
 *                             see the note on what works today.
 *
 * WHAT THIS BUYS TODAY vs LATER, stated honestly because the difference
 * is easy to overclaim:
 *
 *   TODAY   stale-while-revalidate is honoured by browsers, so a repeat
 *           navigation renders from cache instantly instead of blocking
 *           on the network. Real, immediate, no infrastructure change.
 *
 *   LATER   s-maxage does nothing until the API is served through a CDN
 *           we control. It currently answers on medinstru-api.onrender.com,
 *           fronted by RENDER's Cloudflare, which returns
 *           cf-cache-status: DYNAMIC -- it does not cache our responses.
 *           Putting the API behind api.laxair.shop is what activates it.
 *
 * Shipping the header now is deliberate: it is correct either way, and it
 * means the DNS change alone flips edge caching on rather than requiring
 * a coordinated code deploy at the same time.
 */

/**
 * How long a shared cache may serve a product response without asking.
 *
 * 60s is deliberately conservative. The catalogue changes rarely, so a
 * much longer window would be defensible on hit-rate alone -- but there
 * is no cache-invalidation path yet (no purge on write), so this doubles
 * as the worst-case staleness a seller would see after editing a listing.
 * Raise it once an invalidation hook exists, not before.
 */
export const GRAPHQL_SHARED_MAX_AGE_SECONDS = 60;

/**
 * How long a stale response may still be served while a fresh one is
 * fetched in the background.
 *
 * Longer than s-maxage on purpose: past 60s the data is stale but still
 * far better than a spinner, and the refresh happens off the critical
 * path. This is the directive doing the visible work today.
 */
export const GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS = 300;

/** The assembled header value. */
export function graphqlCacheControl(
  sharedMaxAge = GRAPHQL_SHARED_MAX_AGE_SECONDS,
  staleWhileRevalidate = GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS,
): string {
  return [
    'public',
    'max-age=0',
    `s-maxage=${sharedMaxAge}`,
    `stale-while-revalidate=${staleWhileRevalidate}`,
    // Kept alongside s-maxage: it constrains the BROWSER, which s-maxage
    // deliberately does not touch. Dropping it would let a browser reuse
    // a response past max-age without revalidating in some conditions.
    'must-revalidate',
  ].join(', ');
}
