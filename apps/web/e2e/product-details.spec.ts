import { test, expect, type Page } from "@playwright/test";

// The product-details page (#92, first slice) — standalone, server-rendered
// per product. Real product ids use cuid() (see apps/api/prisma/seed.ts)
// and CI reseeds fresh every run, so no id can be hardcoded here — each
// test discovers a real one by clicking the first real card on the
// listing page and reading the resulting URL, matching this repo's own
// "drive everything through the real UI" e2e philosophy. Extracted into
// firstProductHref below on its genuine third occurrence, which is this
// repo's own convention (see skeleton.tsx) -- not preemptively.

/** A real product URL, discovered by reading the first card on the listing. */
async function firstProductHref(page: Page): Promise<string> {
  await page.goto("/en");
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  const href = await page
    .locator('[data-slot="card-title"] a')
    .first()
    .getAttribute("href");
  expect(href).toBeTruthy();
  return href!;
}

test.describe("product details page", () => {
  test("navigating from the listing opens the product's detail page", async ({
    page,
  }) => {
    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();

    const firstCardTitle = await page
      .locator('[data-slot="card-title"]')
      .first()
      .textContent();

    await page.locator('[data-slot="card-title"] a').first().click();

    await page.waitForURL(/\/en\/products\/[^/]+$/);
    await expect(
      page.getByRole("heading", { level: 1, name: firstCardTitle ?? "" }),
    ).toBeVisible();
  });

  test("direct navigation to a real product URL renders the full page", async ({
    page,
  }) => {
    // Discover a real id first (via the listing), then navigate to it
    // directly -- proves SSR works on a cold/shared-link visit, not just
    // client-side navigation from within the app.
    await page.goto(await firstProductHref(page));

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // getByRole("heading", ...), not getByText -- "Specifications" as
    // plain text also substring-matches "No additional specifications
    // listed.", a real strict-mode violation Playwright caught directly.
    await expect(
      page.getByRole("heading", { name: "Specifications" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Seller" })).toBeVisible();
  });

  test("a nonexistent product id shows a clear not-found page with a way back", async ({
    page,
  }) => {
    const response = await page.goto("/en/products/does-not-exist");

    // A real 404 status, not a 200 with a "not found"-looking page --
    // this route deliberately has no loading.tsx specifically to
    // preserve this (see page.tsx's own comment).
    expect(response?.status()).toBe(404);

    await expect(
      page.getByRole("heading", { name: "Product not found" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to listings" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Back to listings" }).click();
    await page.waitForURL(/\/en$/);
    await expect(
      page.getByRole("heading", { name: "Featured listings" }),
    ).toBeVisible();
  });

  test("a buyer can send an inquiry, and is told only that it was recorded", async ({
    page,
  }) => {
    // The whole path in one test: form -> GraphQL mutation -> Postgres row.
    // The unit tests mock the API layer and the API tests never touch a
    // browser, so nothing else proves the two halves agree on the wire.
    await page.goto(await firstProductHref(page));

    await page.getByLabel("Your name").fill("Asha Rao");
    // A FRESH number per run, not a fixture. The per-phone-per-product limit
    // counts stored rows over an hour, so a fixed number makes this test pass
    // once and then fail on every retry and re-run against the same database
    // -- and it would fail as a rate-limit rejection, which reads like a
    // broken form rather than a test reusing its own bucket.
    const phone = `+9199${Math.floor(Math.random() * 1e8)
      .toString()
      .padStart(8, "0")}`;
    await page.getByLabel("Your phone number").fill(phone);
    await page.getByLabel("Your question").fill("Is this available in Chennai?");
    await page.getByRole("button", { name: "Send inquiry" }).click();

    const confirmation = page.getByRole("status");
    await expect(confirmation).toContainText("Inquiry received");
    // Nothing delivers yet, so the confirmation must not imply the seller
    // has the message. Asserted here as well as in the component test
    // because this is the copy a real buyer actually sees.
    await expect(confirmation).toContainText("recorded");
    await expect(confirmation).not.toContainText(/delivered|on its way/i);
  });
});
