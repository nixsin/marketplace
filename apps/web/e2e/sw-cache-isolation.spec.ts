import { test, expect, type Page } from "@playwright/test";

// Proves the actual safety property #78's §3.6 exists to guarantee: the
// service worker (public/sw.js) must never cache a GraphQL response that
// could be user-specific. Cache Storage matches by request, not by who's
// asking, so caching every GET to /graphql by pathname alone (the
// original design) would let one user's cached authenticated response be
// served to a different user hitting the same entry -- a real risk the
// moment any authenticated query (apps/api/src/auth/auth.resolver.ts's
// `me`) is ever sent via GET, which nothing at the transport level
// currently prevents.
//
// A real review round caught that an earlier version of this check
// (allowlisting by operation *name*, parsed out of the query text) was
// itself bypassable: a caller can select which operation actually runs
// via a separate `operationName` parameter regardless of what appears
// first in the query text, and nothing stops a request from simply
// *naming* an unrelated query "ProductsPaged". The tests below cover
// both of those, plus the credentials check, not just the original
// Authorization-header case.
//
// Runs against a real production build with the service worker actually
// registered (playwright.config.ts's webServer is `pnpm build && pnpm
// start`, and service-worker-registration.tsx only registers when
// NODE_ENV === "production") -- this is genuine SW behavior, not a
// simulation.

const REAL_PRODUCTS_PAGED_QUERY =
  "query ProductsPaged($page: Int, $pageSize: Int) { productsPaged(page: $page, pageSize: $pageSize) { page pageSize totalCount totalPages items { id name brand category deviceClass certifications location description imageUrl seller { name } } } }";

// Not hardcoded to a specific literal cache name -- sw.js's own CACHE_NAME
// is free to change (its own comment says to bump it when the caching
// *strategy* changes), and this test shouldn't silently stop meaning
// anything if it does. Discovers whichever cache the active service
// worker is actually using, the same way a real client would.
async function graphqlCacheKeyCount(page: Page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    let count = 0;
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      count += keys.filter((req) => new URL(req.url).pathname === "/graphql").length;
    }
    return count;
  });
}

// Waits for the real page load's own fetchProductsPaged call (query
// ProductsPaged(...)) to finish being cached by the SW's background
// revalidation fetch, and returns the real GraphQL origin it used. The
// request listener is registered *before* navigating -- registering it
// after page.goto() (an earlier version of this test did) races the
// page's own request, which can fire during navigation/initial render
// and be missed entirely, a real flake caught by review.
async function loadPageAndWaitForRealCacheEntry(page: Page) {
  const graphqlRequestPromise = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/graphql",
  );
  await page.goto("/en");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
    timeout: 15_000,
  });
  const graphqlRequest = await graphqlRequestPromise;
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  await expect.poll(() => graphqlCacheKeyCount(page), { timeout: 10_000 }).toBe(1);
  return new URL(graphqlRequest.url()).origin;
}

// Cache Storage's put() replaces an existing entry at the same key rather
// than adding a new one -- so a synthetic request reusing the exact same
// URL as an already-cached legitimate entry (the Authorization and
// credentials tests both do, since they exercise the real, allowlisted
// query+variables) could get cached by a vulnerable worker without the
// key COUNT changing at all. A real AI review caught this (2026-08-18):
// the previous version of this helper compared graphqlCacheKeyCount()
// before/after, which is blind to exactly that in-place replacement.
// Deleting the specific key first, then checking for its absence after,
// closes the gap regardless of whether the URL was already cached.
async function deleteCacheEntry(page: Page, url: string) {
  await page.evaluate(async (url) => {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      await cache.delete(url);
    }
  }, url);
}

async function cacheHasEntry(page: Page, url: string) {
  return page.evaluate(async (url) => {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      if (await cache.match(url)) return true;
    }
    return false;
  }, url);
}

async function assertRequestNeverCached(
  page: Page,
  url: string,
  init: RequestInit,
) {
  await deleteCacheEntry(page, url);

  const fetchOk = await page.evaluate(
    async ({ url, init }) => {
      try {
        const res = await fetch(url, init);
        return res.ok;
      } catch {
        return false;
      }
    },
    { url, init },
  );
  // The synthetic request must actually reach a real response for this
  // assertion to mean anything -- the same review flagged that a blanket
  // swallowed fetch failure (a CORS/network error, unrelated to the
  // service worker's own eligibility check) could make a broken check
  // look like it's working. See the credentials:"include" test below for
  // the one case where this can't be a real cross-origin request at all.
  expect(fetchOk, "synthetic request must succeed for this assertion to be meaningful").toBe(true);

  expect(await cacheHasEntry(page, url)).toBe(false);
}

test.describe("service worker GraphQL cache isolation", () => {
  test("caches the real, allowlisted product query", async ({ page }) => {
    await loadPageAndWaitForRealCacheEntry(page);
  });

  test("never caches a /graphql request carrying an Authorization header, even for the allowlisted query", async ({
    page,
  }) => {
    const graphqlOrigin = await loadPageAndWaitForRealCacheEntry(page);
    const url = `${graphqlOrigin}/graphql?query=${encodeURIComponent(
      REAL_PRODUCTS_PAGED_QUERY,
    )}&variables=${encodeURIComponent(JSON.stringify({ page: 1, pageSize: 4 }))}`;

    await assertRequestNeverCached(page, url, {
      headers: {
        Authorization: "Bearer test-token-should-never-be-cached",
        "apollo-require-preflight": "true",
      },
      credentials: "omit",
    });
  });

  test("never caches a /graphql request sent with credentials included, even for the allowlisted query", async ({
    page,
  }) => {
    await loadPageAndWaitForRealCacheEntry(page);

    // Deliberately NOT the real cross-origin API here, unlike the other
    // three negative tests. Verified directly (curl -X OPTIONS against a
    // live local API): apps/api's bare app.enableCors() never sends
    // Access-Control-Allow-Credentials, and its Access-Control-Allow-
    // Origin is the literal wildcard "*" -- per the Fetch spec, a browser
    // refuses to expose a credentialed cross-origin response under that
    // combination regardless of what the service worker does. A real
    // fetch(..., {credentials:"include"}) against the actual API would
    // therefore always fail at the browser's own CORS layer, making this
    // test pass vacuously whether or not sw.js's own `credentials !==
    // "omit"` check exists at all -- proving nothing about the code this
    // test is named for.
    //
    // isPublicGraphqlRead() matches on pathname alone, not origin (see
    // its own comment in sw.js), so a same-origin request exercises the
    // exact same decision path without the CORS confound -- no
    // Access-Control-* headers needed in the mock below since CORS
    // enforcement never applies to a same-origin request in the first
    // place. Routing through a context-level mock (rather than the real
    // Next.js app, which has no /graphql route of its own to answer this)
    // isolates what's being tested to the service worker's own check.
    // Confirmed empirically before relying on this: page.context().route()
    // does reach the service worker's own internal fetch (not just the
    // page's outer call) -- with a temporarily-reverted vulnerable sw.js
    // (the credentials check disabled), this exact setup showed the mock
    // response actually landing in the cache; with the real, correct
    // sw.js, it doesn't.
    const sameOriginUrl = `/graphql?query=${encodeURIComponent(
      REAL_PRODUCTS_PAGED_QUERY,
    )}&variables=${encodeURIComponent(JSON.stringify({ page: 1, pageSize: 4 }))}`;

    await page.context().route("**/graphql**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            productsPaged: { page: 1, pageSize: 4, totalCount: 0, totalPages: 0, items: [] },
          },
        }),
      });
    });

    await assertRequestNeverCached(page, sameOriginUrl, {
      headers: { "apollo-require-preflight": "true" },
      credentials: "include",
    });
  });

  test("never caches a /graphql request for a query merely named like the allowlisted one, selecting different fields", async ({
    page,
  }) => {
    const graphqlOrigin = await loadPageAndWaitForRealCacheEntry(page);
    // Same operation *name* as the real allowlisted query, but a
    // completely different selection set -- proves the check is on exact
    // query text, not a name parsed out of it.
    const spoofedQuery = "query ProductsPaged { me { id } }";
    const url = `${graphqlOrigin}/graphql?query=${encodeURIComponent(
      spoofedQuery,
    )}&variables=${encodeURIComponent("{}")}`;

    await assertRequestNeverCached(page, url, {
      headers: { "apollo-require-preflight": "true" },
      credentials: "omit",
    });
  });

  test("never caches a /graphql request that uses operationName to select a different operation than the one named first", async ({
    page,
  }) => {
    const graphqlOrigin = await loadPageAndWaitForRealCacheEntry(page);
    // A document naming the real public query first, but selecting a
    // different operation to actually execute via operationName -- proves
    // the check rejects operationName outright rather than trusting
    // whichever operation appears first in the text.
    const multiOpQuery = `${REAL_PRODUCTS_PAGED_QUERY} query Me { me { id } }`;
    const url = `${graphqlOrigin}/graphql?query=${encodeURIComponent(
      multiOpQuery,
    )}&variables=${encodeURIComponent("{}")}&operationName=Me`;

    await assertRequestNeverCached(page, url, {
      headers: { "apollo-require-preflight": "true" },
      credentials: "omit",
    });
  });
});
