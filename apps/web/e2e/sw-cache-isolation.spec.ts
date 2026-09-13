import { test, expect, type Page } from "@playwright/test";

// Pins the standing rule in public/sw.js: the service worker caches PAGE
// NAVIGATIONS and nothing else. No API response is cached there, ever.
//
// This file used to prove the opposite property -- that a carefully
// allowlisted GraphQL read WAS cached, and that every adversarial shape
// around it was not. That allowlist is gone, so the safety argument it
// defended is now structural rather than conditional: Cache Storage
// matches by request, NOT by who is asking, and it cannot partition by
// user identity. Caching any /graphql GET is therefore only safe while
// every such response is genuinely public -- which stopped being
// guaranteed the moment an authenticated query existed in the schema
// (auth.resolver.ts's `me`, behind JwtAuthGuard), and nothing at the
// transport level prevents one being sent by GET.
//
// The adversarial shapes below are kept deliberately. They are no longer
// probing an allowlist's edges; they are the paths a reintroduction would
// most plausibly take, so each one failing here is what makes the rule
// hold rather than merely be stated.
//
// Runs against a real production build with the worker actually
// registered (playwright.config.ts's webServer is `pnpm build && pnpm
// start`, and service-worker-registration.tsx only registers when
// NODE_ENV === "production") -- genuine SW behaviour, not a simulation.

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

/** Every cached key whose pathname is /graphql, across every cache. */
async function graphqlCacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const found: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname === "/graphql") found.push(request.url);
      }
    }
    return found;
  });
}

/**
 * Loads the listing under a controlling worker and returns once a real
 * ProductsPaged request has actually been issued.
 *
 * The reload is load-bearing and predates this change: clients.claim() in
 * the activate handler resolves asynchronously, so the FIRST load's own
 * fetch can fire before the worker controls the page. A reload issued
 * after control is confirmed is controlled from its very first request.
 * Without it this suite passes for the wrong reason -- nothing was cached
 * because nothing was controlled.
 */
async function loadListingUnderWorker(page: Page) {
  await page.goto("/en");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
    timeout: 15_000,
  });
  // The RESPONSE, not merely the request: a background cache.put cannot
  // start before the response exists, so waiting on the request alone
  // would begin sampling too early to observe one.
  const graphqlResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/graphql",
  );
  await page.reload();
  const graphqlResponse = await graphqlResponsePromise;
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  return graphqlResponse.url();
}

/**
 * Asserts NO /graphql entry appears at any point across a window.
 *
 * `expect.poll(...).toEqual([])` is the wrong tool here and silently
 * passes against the exact regression this file guards: poll retries until
 * the assertion SUCCEEDS, so an already-empty cache satisfies it on the
 * first sample and stops. But a stale-while-revalidate worker writes from a
 * background fetch that resolves AFTER the response was delivered -- so the
 * cache is legitimately empty at t=0 and populated a moment later, and the
 * test is long finished. Caught in review; the first version of this file
 * had precisely that hole, under a comment claiming it did not.
 *
 * Sampling repeatedly and failing on the first non-empty observation is
 * what actually covers the delayed write.
 */
async function assertGraphqlCacheStaysEmpty(page: Page, windowMs = 3_000) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    expect(
      await graphqlCacheKeys(page),
      "no /graphql response may ever be cached by the service worker",
    ).toEqual([]);
    if (Date.now() >= deadline) return;
    await page.waitForTimeout(250);
  }
}

async function assertNeverCached(page: Page, url: string, init: RequestInit) {
  const fetchOk = await page.evaluate(
    async ({ url, init }) => {
      try {
        return (await fetch(url, init)).ok;
      } catch {
        return false;
      }
    },
    { url, init },
  );
  // The synthetic request must reach a real response or this assertion is
  // vacuous -- a swallowed CORS/network failure would make a broken check
  // look like it works. Caught by a review on the previous version.
  expect(fetchOk, "synthetic request must succeed for this assertion to mean anything").toBe(true);

  // Sampled, not read once, for the delayed-write reason above: a
  // background cache.put lands after the fetch has already resolved here.
  const deadline = Date.now() + 2_000;
  for (;;) {
    expect(await cacheHasEntry(page, url), `must not be cached: ${url.slice(0, 80)}`).toBe(false);
    if (Date.now() >= deadline) return;
    await page.waitForTimeout(250);
  }
}

test.describe("service worker caches navigations only", () => {
  test("caches the page navigation, so the shell still paints instantly", async ({ page }) => {
    // The worker's actual job, and the reason it exists on a free tier
    // that spins down after 15 minutes. Deleting API caching must not
    // quietly delete this too.
    await loadListingUnderWorker(page);
    await expect
      .poll(() => cacheHasEntry(page, page.url()), { timeout: 10_000 })
      .toBe(true);
  });

  test("caches NO /graphql response, even the one the app really sends", async ({ page }) => {
    // The rule. This is the exact request fetchProductsPaged issues on a
    // real listing load -- previously allowlisted and cached on purpose.
    const realUrl = await loadListingUnderWorker(page);
    expect(new URL(realUrl).pathname).toBe("/graphql");

    await assertGraphqlCacheStaysEmpty(page);
  });

  test("caches no /graphql response in any shape a reintroduction might take", async ({ page }) => {
    const realUrl = await loadListingUnderWorker(page);
    const origin = new URL(realUrl).origin;
    const q = (query: string) => `${origin}/graphql?query=${encodeURIComponent(query)}`;

    // `apollo-require-preflight` is REQUIRED on every one of these, and
    // leaving it off is not a detail: Apollo Server's CSRF protection
    // rejects a GET without a preflight-triggering header, so the fetch
    // never reaches a real response and the cache assertion after it
    // asserts nothing. Omitted in the first version of this file and
    // caught by CI -- by the `fetchOk` guard inside assertNeverCached,
    // which exists for exactly this and was itself added by an earlier
    // review. It refused to let a vacuous assertion pass as a green test.
    const init: RequestInit = {
      headers: { "apollo-require-preflight": "true" },
      credentials: "omit",
    };

    // The real request the app actually issued (query AND variables, taken
    // from the browser rather than reconstructed), an unauthenticated
    // read, and a query merely NAMED like the old allowlisted one while
    // selecting other fields -- the last being the bypass a review caught
    // in the allowlist era.
    for (const url of [
      realUrl,
      q("{__typename}"),
      q("query ProductsPaged { __typename }"),
    ]) {
      await assertNeverCached(page, url, init);
    }

    await assertGraphqlCacheStaysEmpty(page, 2_000);
  });
});
