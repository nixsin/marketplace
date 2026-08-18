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

async function assertRequestNeverCached(
  page: Page,
  graphqlOrigin: string,
  url: string,
  init: RequestInit,
) {
  const baseline = await graphqlCacheKeyCount(page);
  await page.evaluate(
    async ({ url, init }) => {
      await fetch(url, init).catch(() => {
        // A CORS/network failure here is fine -- these assertions only
        // care whether Cache Storage gained an entry, not whether the
        // synthetic request succeeded end to end.
      });
    },
    { url, init },
  );
  expect(await graphqlCacheKeyCount(page)).toBe(baseline);
  void graphqlOrigin;
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

    await assertRequestNeverCached(page, graphqlOrigin, url, {
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
    const graphqlOrigin = await loadPageAndWaitForRealCacheEntry(page);
    const url = `${graphqlOrigin}/graphql?query=${encodeURIComponent(
      REAL_PRODUCTS_PAGED_QUERY,
    )}&variables=${encodeURIComponent(JSON.stringify({ page: 1, pageSize: 4 }))}`;

    await assertRequestNeverCached(page, graphqlOrigin, url, {
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

    await assertRequestNeverCached(page, graphqlOrigin, url, {
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

    await assertRequestNeverCached(page, graphqlOrigin, url, {
      headers: { "apollo-require-preflight": "true" },
      credentials: "omit",
    });
  });
});
