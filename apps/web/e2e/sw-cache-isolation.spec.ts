import { test, expect, type Page } from "@playwright/test";
import { PRODUCTS_PAGED_QUERY } from "../src/lib/api";

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

const REAL_PRODUCTS_PAGED_QUERY = PRODUCTS_PAGED_QUERY;

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
  const graphqlRequestPromise = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/graphql",
  );
  await page.reload();
  const graphqlRequest = await graphqlRequestPromise;
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  return graphqlRequest.url();
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
  expect(await cacheHasEntry(page, url)).toBe(false);
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

    // Polled rather than read once: the old worker cached from a
    // background revalidation fetch that completed AFTER the response was
    // delivered, so a single immediate read could miss a regression that a
    // moment later would be plainly visible.
    await expect
      .poll(() => graphqlCacheKeys(page), { timeout: 10_000 })
      .toEqual([]);
  });

  test("caches no /graphql response in any shape a reintroduction might take", async ({ page }) => {
    const realUrl = await loadListingUnderWorker(page);
    const origin = new URL(realUrl).origin;
    const q = (query: string) => `${origin}/graphql?query=${encodeURIComponent(query)}`;

    // The real allowlisted query, an unauthenticated read, and a query
    // merely NAMED like the allowlisted one while selecting other fields
    // -- the last being the bypass a review caught in the allowlist era.
    for (const url of [
      q(REAL_PRODUCTS_PAGED_QUERY),
      q("{__typename}"),
      q("query ProductsPaged { __typename }"),
    ]) {
      await assertNeverCached(page, url, { credentials: "omit" });
    }

    await expect.poll(() => graphqlCacheKeys(page), { timeout: 5_000 }).toEqual([]);
  });
});
