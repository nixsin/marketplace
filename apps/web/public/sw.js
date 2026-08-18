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
// Server's GET support isn't restricted to specific operations. Two
// independent checks below, deliberately not relying on either one alone:
// an explicit allowlist of known-public operation names, and a hard
// refusal to touch anything carrying credentials, regardless of what
// operation it claims to be.

// Only operations confirmed public and side-effect-free. Add to this list
// deliberately, not by default, when a new public query is introduced.
const PUBLIC_GRAPHQL_OPERATIONS = new Set(["ProductsPaged"]);

function graphqlOperationName(url) {
  const query = url.searchParams.get("query");
  if (!query) return null;
  // GraphQL-over-GET puts the full query text in this param -- named
  // operations start "query <Name>(" or "query <Name>{"; anonymous
  // queries (no name) are never treated as public, since there's nothing
  // to allowlist against.
  const match = /^\s*query\s+(\w+)/.exec(query);
  return match ? match[1] : null;
}

function isPublicGraphqlRead(request, url) {
  if (url.pathname !== "/graphql") return false;
  // Independent of the operation-name check below -- a request carrying
  // credentials is never cacheable, full stop, regardless of what
  // operation it claims to be. This is the check that must not depend on
  // the allowlist being kept correct.
  if (request.headers.has("Authorization")) return false;
  const operation = graphqlOperationName(url);
  return operation !== null && PUBLIC_GRAPHQL_OPERATIONS.has(operation);
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
