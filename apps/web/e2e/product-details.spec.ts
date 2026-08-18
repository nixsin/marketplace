import { test, expect } from "@playwright/test";

// The product-details page (#92, first slice) — standalone, server-rendered
// per product. Real product ids use cuid() (see apps/api/prisma/seed.ts)
// and CI reseeds fresh every run, so no id can be hardcoded here — each
// test discovers a real one by clicking the first real card on the
// listing page and reading the resulting URL, matching this repo's own
// "drive everything through the real UI" e2e philosophy. Duplicated per
// test rather than extracted into a shared helper -- only two tests need
// it right now; this repo's own convention (see skeleton.tsx) is to
// extract on a real third occurrence, not preemptively.

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
    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
    const href = await page
      .locator('[data-slot="card-title"] a')
      .first()
      .getAttribute("href");
    expect(href).toBeTruthy();

    await page.goto(href!);

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
});
