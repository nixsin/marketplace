// Paints the shell instantly on repeat visits instead of showing a blank
// page while the network round-trip happens — the free Render web/API tiers
// spin down after 15 minutes idle, so a cold visit can otherwise mean a
// 30-50s wait. Stale-while-revalidate: serve whatever's cached immediately,
// then fetch fresh in the background and update the cache for next time.
//
// Only two request kinds are worth this: same-origin page navigations (the
// HTML shell) and GraphQL-over-GET reads (see src/lib/api.ts). Everything
// else — content-hashed /_next/static/* assets, images — is left to the
// browser's native HTTP cache, which Next already serves those with
// long-lived immutable Cache-Control for; duplicating that here would just
// be two caches doing the same job.
//
// Bump this when the caching *strategy* below changes, not for ordinary
// content updates — those self-heal within one background fetch cycle.
const CACHE_NAME = "medinstru-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? networkFetch;
}

// Cache Storage matches by request, not by who's asking — it does not
// partition entries by user identity. Caching every GET to /graphql by
// pathname alone (the original design) is only safe as long as every such
// response is genuinely public, which stopped being guaranteed the moment
// an authenticated query (apps/api/src/auth/auth.resolver.ts's `me`,
// guarded by JwtAuthGuard) existed in the schema — nothing at the
// transport level stops a future GET from carrying it, since Apollo
// Server's GET support isn't restricted to specific operations.
//
// An earlier version of this file allowlisted by *operation name*
// (extracted from the query text) rather than the query itself — a real
// review caught that this is trivially bypassable two ways: (1) a GraphQL
// document can name multiple operations and select which one actually
// runs via a separate `operationName` parameter, so trusting only the
// first name in the text can be tricked into treating a request as public
// when a *different* operation is what actually executes; (2) nothing
// stops a request from simply naming an unrelated, sensitive query
// "ProductsPaged" — the name is caller-controlled and says nothing about
// which fields are actually selected. Checking only for an `Authorization`
// header had the same shape of gap: it says nothing about cookie-carried
// credentials.
//
// Fixed by two independent, positive checks instead: the exact,
// canonical query *text* (not a name parsed out of it) against a fixed
// allowlist, and requiring the request to have been made with
// `credentials: "omit"` (src/lib/api.ts sets this explicitly) — asking
// what the request itself declares, not trying to enumerate every
// possible credential-carrying mechanism after the fact.

// Exact, canonical query text for every operation confirmed public and
// side-effect-free — not an operation name. Must stay byte-for-byte in
// sync with src/lib/api.ts's PRODUCTS_PAGED_QUERY (after its own
// whitespace minification); the e2e suite's "caches the real, allowlisted
// product query" test exercises the real app's real request, so drift
// here fails that test immediately rather than silently.
const PUBLIC_GRAPHQL_QUERIES = new Set([
  "query ProductsPaged($page: Int, $pageSize: Int) { productsPaged(page: $page, pageSize: $pageSize) { page pageSize totalCount totalPages items { id name brand category deviceClass certifications location description imageUrl seller { name } } } }",
]);

function isPublicGraphqlRead(request, url) {
  if (url.pathname !== "/graphql") return false;
  // Two independent credential checks, not one instead of the other --
  // `credentials` governs whether the browser attaches cookies; an
  // `Authorization` header is a separate, explicit bearer token (this
  // app's real auth guard is literally named JwtAuthGuard) that
  // `credentials: "omit"` says nothing about either way. A request could
  // set both `credentials: "omit"` and still carry a real bearer token --
  // caught directly by this file's own e2e suite when an earlier version
  // of this check dropped the Authorization check while adding the
  // credentials one, instead of keeping both.
  if (request.credentials !== "omit") return false;
  if (request.headers.has("Authorization")) return false;
  // A GraphQL document can name multiple operations and pick which one
  // runs via this separate parameter -- this app never sends it, so
  // requiring its absence costs nothing today and closes the whole
  // multi-operation ambiguity class of bypass.
  if (url.searchParams.has("operationName")) return false;
  const query = url.searchParams.get("query");
  return query !== null && PUBLIC_GRAPHQL_QUERIES.has(query.trim());
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never cache mutations

  const url = new URL(request.url);
  const isNavigation = request.mode === "navigate";
  // Matched on pathname alone (plus the safety checks above), not origin:
  // NEXT_PUBLIC_API_URL is inlined into the client bundle at build time,
  // and this is a static file that can't read it — but the API's GraphQL
  // endpoint is always at /graphql regardless of which host serves it.
  const isGraphqlRead = isPublicGraphqlRead(request, url);

  if (isNavigation || isGraphqlRead) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
