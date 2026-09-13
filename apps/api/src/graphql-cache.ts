import {
  staleWhileRevalidateCacheControl,
  strictCacheControl,
  SHARED_MAX_AGE_SECONDS,
  STALE_WHILE_REVALIDATE_SECONDS,
} from '@medinstru/config';

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
export const GRAPHQL_SHARED_MAX_AGE_SECONDS = SHARED_MAX_AGE_SECONDS;

/**
 * How long a stale response may still be served while a fresh one is
 * fetched in the background.
 *
 * Longer than s-maxage on purpose: past 60s the data is stale but still
 * far better than a spinner, and the refresh happens off the critical
 * path. This is the directive doing the visible work today.
 */
export const GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS =
  STALE_WHILE_REVALIDATE_SECONDS;

/**
 * Which cache policy a successful GraphQL response gets.
 *
 *   listing (`products`, `productsPaged`)  strict TTL, NEVER stale.
 *   detail  (`product`)                    TTL, stale served while it
 *                                          revalidates.
 *
 * The split is a product decision about what each surface can tolerate. A
 * listing is how a buyer discovers what exists, so showing an item that
 * has been withdrawn -- or missing one just added -- is worse than the
 * revalidation round trip it costs. A detail page is already about one
 * known product, so painting it instantly from a slightly old copy while
 * a fresh one loads behind is the better trade.
 *
 * TAKES THE RESOLVED SCHEMA FIELDS, AND THAT IS THE WHOLE POINT. An
 * earlier version read the top-level keys of the serialised `data` object
 * and claimed they could not be spoofed. They can: GraphQL ALIASES become
 * the response keys, so `{ product: productsPaged(...) }` serialises under
 * `data.product` and would have selected the stale-tolerant policy for a
 * listing -- exactly the bypass the strict policy exists to prevent. The
 * reverse works too, aliasing a real detail into the strict policy.
 * Caught in review before it shipped.
 *
 * `rootFieldNames` below reads the field names off the PARSED operation,
 * where the schema field and the alias are separate nodes, so an alias
 * cannot change the answer.
 *
 * FAILS CLOSED TOWARD STRICT. No fields, an unrecognised one, or an
 * operation this cannot read (a root fragment spread) all get the
 * never-stale policy. A new query silently inheriting permission to serve
 * stale data is the failure worth designing out; the cost of guessing
 * wrong the other way is one revalidation.
 */
const STALE_TOLERANT_FIELDS = new Set(['product']);

/** A root selection, narrowed to what this needs from graphql's AST. */
interface RootSelection {
  kind: string;
  name?: { value?: string };
}

/**
 * The SCHEMA field names a root selection set resolves, ignoring aliases.
 *
 * Returns null when the answer cannot be known from the selection set
 * alone -- a root `...fragmentSpread` or inline fragment, whose contents
 * live elsewhere in the document. Null means strict, not "assume none".
 */
export function rootFieldNames(
  selections: readonly RootSelection[] | undefined,
): string[] | null {
  if (!selections || selections.length === 0) return null;
  const names: string[] = [];
  for (const selection of selections) {
    // `Field` carries `name` (the schema field) and, separately, `alias`.
    // Reading `name` is what makes an alias unable to change the policy.
    if (selection.kind !== 'Field') return null;
    const name = selection.name?.value;
    if (typeof name !== 'string' || name.length === 0) return null;
    names.push(name);
  }
  return names;
}

/** The header value for a response that resolved these root fields. */
export function cachePolicyFor(fields: string[] | null | undefined): string {
  // EVERY field must tolerate staleness, not merely one: a single request
  // can select both `product` and `productsPaged`, and one header governs
  // the whole response. The strict half wins.
  const allTolerant =
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.every((f) => STALE_TOLERANT_FIELDS.has(f));

  return allTolerant
    ? staleWhileRevalidateCacheControl(
        GRAPHQL_SHARED_MAX_AGE_SECONDS,
        GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS,
      )
    : strictCacheControl(GRAPHQL_SHARED_MAX_AGE_SECONDS);
}

/**
 * Where the plugin stashes the resolved fields for the send-patch to read.
 *
 * On the Express request rather than a module-level map: the request is
 * the thing both halves already share, and anything keyed globally would
 * have to be cleaned up and could leak one request's policy into another
 * under concurrency.
 */
export const ROOT_FIELDS_KEY = '__graphqlRootFields';

/**
 * Whether a GraphQL GET response may be handed to a shared cache.
 *
 * WHY THIS IS NOT JUST A STATUS-CODE CHECK, which is the whole point:
 * GraphQL reports resolver failures as HTTP **200** with an `errors` array
 * in the body. So "did it succeed" is a property of the BODY, not the
 * status line, and a cache that only looks at the status line cannot tell
 * a product listing from "Product not found".
 *
 * That distinction was academic while nothing cached these responses. It
 * stops being academic the moment the API is served through a CDN: a
 * one-second database blip during a listing query would be stored at the
 * edge for s-maxage seconds and then served stale for the whole
 * stale-while-revalidate window on top, to every visitor routed through
 * that location. A blip becomes a multi-minute outage, and there is no
 * purge hook yet to cut it short. Verified against the deployed API
 * before writing this -- `{product(id:"does-not-exist"){id}}` returned
 * HTTP 200 carrying the full cacheable header.
 *
 * FAILS CLOSED, deliberately and in every branch: an unparseable body, a
 * body that is not a JSON object, a missing `data` key, an absent chunk.
 * Not caching something cacheable costs a round trip. Caching an error
 * costs an outage, so every ambiguous case resolves to "do not cache".
 *
 * Note on cost: this re-parses a body the server just serialised. That is
 * real but small next to the database query it accompanies, and it buys
 * a decision made on the actual response rather than on a guess about
 * Apollo's internal plugin ordering.
 */
export function isCacheableGraphqlResponse(
  statusCode: number,
  body: unknown,
): boolean {
  // Apollo answers parse/validation/CSRF failures with 4xx. Only a plain
  // 200 can carry a cacheable result.
  if (statusCode !== 200) return false;

  let text: string;
  if (typeof body === 'string') text = body;
  else if (Buffer.isBuffer(body)) text = body.toString('utf8');
  // Covers res.end() with no chunk and res.end(callback) -- neither
  // carries a body we can vouch for.
  else return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  // A GraphQL response is a JSON object. An array or a bare scalar is
  // something else entirely, and not something to cache on this path.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  const response = parsed as { data?: unknown; errors?: unknown };

  // Any `errors` key at all disqualifies the response, including an empty
  // array. The spec says `errors` must be omitted when there are none, so
  // its presence already signals something went wrong -- and treating
  // "present but empty" as success would be a guess, which this function
  // does not make.
  if ('errors' in response) return false;

  // Every successful GraphQL response carries `data`. Requiring it keeps
  // an unrelated JSON body that happens to reach this path -- a proxy
  // error page, say -- from being cached as though it were a result.
  if (!('data' in response)) return false;

  return true;
}
