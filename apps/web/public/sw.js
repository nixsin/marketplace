// Paints the shell instantly on repeat visits instead of showing a blank
// page while the network round-trip happens — the free Render web/API tiers
// spin down after 15 minutes idle, so a cold visit can otherwise mean a
// 30-50s wait. Stale-while-revalidate: serve whatever's cached immediately,
// then fetch fresh in the background and update the cache for next time.
//
// ONE request kind is worth this: same-origin page navigations (the HTML
// shell). Everything else — content-hashed /_next/static/* assets, images —
// is left to the browser's native HTTP cache, which Next already serves
// those with long-lived immutable Cache-Control for; duplicating that here
// would just be two caches doing the same job.
//
// API RESPONSES ARE DELIBERATELY NOT CACHED HERE, and that is a standing
// rule rather than an omission to tidy up later. This worker used to
// allowlist the exact ProductsPaged query text and serve it
// stale-while-revalidate. It worked, and it was the wrong layer:
//
//   - It applied NO age bound. The only thing that evicted an entry was a
//     CACHE_NAME bump, i.e. a deploy. A returning visitor was served
//     whatever was in Cache Storage however old it was, one visit behind
//     forever, and a reload could not fix it.
//   - That silently contradicted the response's own header. The API sends
//     `max-age=0, must-revalidate` precisely so "a reload always
//     revalidates and nobody is stuck on a stale catalogue they cannot
//     refresh" (packages/config/src/index.js). This worker overrode that
//     for the one query it allowlisted, and nothing said so.
//   - It made freshness a three-way argument between the HTTP header, this
//     worker, and the caller — with this worker silently winning.
//
// And the safety argument is the strongest of the three, which is why the
// allowlist had to be so careful in the first place: Cache Storage matches
// by request, NOT by who is asking -- it does not partition by user
// identity. Caching any /graphql GET is therefore only safe while every
// such response is genuinely public, and that stopped being guaranteed the
// moment an authenticated query existed in the schema (auth.resolver.ts's
// `me`, behind JwtAuthGuard). Nothing at the transport level stops a future
// GET from carrying one -- Apollo Server's GET support is not restricted to
// particular operations. The old allowlist defended that with an exact
// query-text match plus independent credentials and Authorization checks.
// All of it was correct, and none of it is needed once no API response is
// cached here at all.
//
// The browser's own HTTP cache can do the same job with a bounded lifetime
// and no custom code, once the response header asks for it. Freshness
// belongs to the header and the caller; user-identity partitioning belongs
// to a cache that has one. Neither belongs here.
//
// Bump this when the caching *strategy* below changes, not for ordinary
// content updates — those self-heal within one background fetch cycle.
//
// v2 (2026-08-21) is a bump for a THIRD reason worth recording, because
// nothing about it is obvious from this file alone: a worker's fetches are
// governed by the CSP served on THIS SCRIPT's own response, captured when
// the worker was installed. Moving the API to api.laxair.shop changed that
// CSP (it is derived from NEXT_PUBLIC_API_URL) without changing a single
// byte here — so Cloudflare revalidated, got a 304, and kept serving its
// stored copy WITH THE OLD HEADER. Workers installed from it enforced
// `connect-src` naming only the retired host and hard-failed every API
// call, and because the script bytes were identical the browser saw no
// reason to install a replacement. Users were stuck with no way out short
// of clearing site data.
//
// So: any change to the CSP this file is served with needs a byte change
// here too, or already-installed workers keep the old policy forever. The
// no-store header now set on /sw.js in next.config.ts stops the edge from
// pinning a stale header in the first place; this bump is what releases
// the workers already holding one.
// v3 (2026-09-13) removes API-response caching entirely -- see the standing
// rule at the top. The bump is required twice over: the caching STRATEGY
// changed, and existing clients still hold /graphql entries in
// medinstru-shell-v2. Those entries would never be served again (the fetch
// handler no longer matches them) but would never be reclaimed either, so
// without this bump they sit in every returning visitor's Cache Storage
// quota indefinitely. The activate handler deletes every key that is not
// CACHE_NAME, which is what actually clears them.
const CACHE_NAME = "medinstru-shell-v3";

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
      // Deliberately not awaited: a cache write must never delay or fail
      // delivery of a response we already have. The trailing catch is not
      // decoration -- without it a rejected put (quota, eviction race) is
      // an unhandled rejection, since nothing downstream is watching this
      // promise. Swallowing it is correct: the caller got its response,
      // and the only cost is that the next visit re-fetches.
      if (response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    // Falling back to the cached copy is the whole point -- but only when
    // there IS one. `.catch(() => cached)` alone resolved to `undefined`
    // on a cold cache.
    //
    // BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT CHANGE, because the
    // obvious reading is wrong and a review caught it: per the Fetch
    // spec, respondWith() yields a network error BOTH when its promise
    // rejects and when it resolves to a non-Response. So the page sees an
    // identical failed fetch either way -- this is not what made the
    // catalogue disappear on 2026-08-21 (a stale edge-cached CSP was; see
    // CACHE_NAME above), and it does not change what a user experiences.
    //
    // What it does change is that the original error survives. The old
    // form discarded the reason and handed back `undefined`, so the
    // worker's own context showed a bare dead request with nothing saying
    // why -- which is precisely why that outage took a header-diff
    // between origin and edge to explain rather than a console message.
    // Re-throwing keeps the cause attached where it is debuggable.
    .catch((error) => {
      if (cached) return cached;
      throw error;
    });
  return cached ?? networkFetch;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never cache mutations

  // Navigations only. Anything else -- API reads above all -- is left to
  // the HTTP cache; see the standing rule at the top of this file.
  if (request.mode === "navigate") {
    event.respondWith(staleWhileRevalidate(request));
  }
});
