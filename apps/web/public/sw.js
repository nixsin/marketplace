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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never cache mutations

  const url = new URL(request.url);
  const isNavigation = request.mode === "navigate";
  // Matched on pathname alone, not origin: NEXT_PUBLIC_API_URL is inlined
  // into the client bundle at build time, and this is a static file that
  // can't read it — but the API's GraphQL endpoint is always at /graphql
  // regardless of which host serves it.
  const isGraphqlRead = url.pathname === "/graphql";

  if (isNavigation || isGraphqlRead) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
