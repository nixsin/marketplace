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
// Runs against a real production build with the service worker actually
// registered (playwright.config.ts's webServer is `pnpm build && pnpm
// start`, and service-worker-registration.tsx only registers when
// NODE_ENV === "production") -- this is genuine SW behavior, not a
// simulation.

async function graphqlCacheKeyCount(page: Page) {
  return page.evaluate(async () => {
    const cache = await caches.open("medinstru-shell-v1");
    const keys = await cache.keys();
    return keys.filter((req) => new URL(req.url).pathname === "/graphql").length;
  });
}

// Waits for the real page load's own fetchProductsPaged call (query
// ProductsPaged(...)) to finish being cached by the SW's background
// revalidation fetch, and returns the real GraphQL origin it used. Doing
// this first, and treating its outcome as the baseline, is what makes the
// negative tests below attribute any *new* cache entry unambiguously to
// the synthetic request they make -- not to a race against this
// already-in-flight, legitimate background write.
async function loadPageAndWaitForRealCacheEntry(page: Page) {
  await page.goto("/en");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
    timeout: 15_000,
  });
  const graphqlRequest = await page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/graphql",
  );
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  await expect.poll(() => graphqlCacheKeyCount(page), { timeout: 10_000 }).toBe(1);
  return new URL(graphqlRequest.url()).origin;
}

test.describe("service worker GraphQL cache isolation", () => {
  test("caches the real, allowlisted product query", async ({ page }) => {
    await loadPageAndWaitForRealCacheEntry(page);
  });

  test("never caches a /graphql request carrying an Authorization header, even for an allowlisted operation", async ({
    page,
  }) => {
    const graphqlOrigin = await loadPageAndWaitForRealCacheEntry(page);
    const baseline = await graphqlCacheKeyCount(page);

    const authedUrl = `${graphqlOrigin}/graphql?query=${encodeURIComponent(
      "query ProductsPaged($page: Int, $pageSize: Int) { productsPaged(page: $page, pageSize: $pageSize) { page } }",
    )}&variables=${encodeURIComponent(JSON.stringify({ page: 1, pageSize: 4 }))}`;

    await page.evaluate(
      async ({ url }) => {
        await fetch(url, {
          headers: {
            Authorization: "Bearer test-token-should-never-be-cached",
            "apollo-require-preflight": "true",
          },
        }).catch(() => {
          // A CORS/network failure here is fine -- the assertion below
          // only cares whether Cache Storage gained an entry, not whether
          // this specific synthetic request succeeded end to end.
        });
      },
      { url: authedUrl },
    );

    // No poll here on purpose -- if this were going to get cached, the
    // SW's fetch handler would call event.respondWith() synchronously
    // within the same task as the fetch; there's no legitimate delayed
    // path that would make a false negative "not yet cached" turn true
    // later, unlike the real page load's own background revalidation.
    expect(await graphqlCacheKeyCount(page)).toBe(baseline);
  });

  test("never caches a /graphql request for a non-allowlisted operation, even without an Authorization header", async ({
    page,
  }) => {
    const graphqlOrigin = await loadPageAndWaitForRealCacheEntry(page);
    const baseline = await graphqlCacheKeyCount(page);

    // Shaped like a real, plausible future authenticated query -- not the
    // actual `me` query's real field set, just enough to exercise the
    // operation-name allowlist independent of the auth-header check.
    const unlistedUrl = `${graphqlOrigin}/graphql?query=${encodeURIComponent(
      "query Me { me { id } }",
    )}&variables=${encodeURIComponent("{}")}`;

    await page.evaluate(
      async ({ url }) => {
        await fetch(url, {
          headers: { "apollo-require-preflight": "true" },
        }).catch(() => {});
      },
      { url: unlistedUrl },
    );

    expect(await graphqlCacheKeyCount(page)).toBe(baseline);
  });
});
