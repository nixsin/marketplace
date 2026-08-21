import { test, expect } from "@playwright/test";

// The one real end-to-end flow that exists today: home page -> product
// listing (real GraphQL call to a real API, against real seeded Postgres
// data — see apps/api/prisma/seed.ts, 10 products / pageSize 4 = 3 pages)
// -> pagination -> language switch. This is genuinely the first test in
// this repo that runs in a real browser engine at all; every other web
// test is a Vitest/jsdom component test. See CLAUDE.md for why this is
// scoped to Chromium only and marked informational rather than required.
//
// Screenshots use Playwright's built-in toHaveScreenshot() — baselines
// live in e2e/critical-flow.spec.ts-snapshots/, committed to the repo.
// A real visual diff fails the assertion and Playwright writes
// -actual/-expected/-diff PNGs next to the baseline; CI uploads the
// full HTML report (with those images) as a workflow artifact on
// failure — a human downloads it to see the diff. Posting the images
// directly to the PR isn't built yet (see CLAUDE.md for the planned
// follow-up) — don't overclaim it here once it exists elsewhere.

test.describe("home page", () => {
  test("renders the real product catalog", async ({ page }) => {
    await page.goto("/en");

    await expect(
      page.getByRole("heading", { name: "Featured listings" }),
    ).toBeVisible();

    // Real data landing, not the loading skeleton or an empty/error
    // state — at least one product card actually rendered. shadcn's Card
    // is a plain styled div (data-slot="card"), not role="article" —
    // matching the real DOM here, not an assumed ARIA role.
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
    const cardCount = await page.locator('[data-slot="card"]').count();
    expect(cardCount).toBeGreaterThan(0);

    await expect(page).toHaveScreenshot("home-en-page-1.png");
  });

  test("pagination navigates to a different set of products", async ({
    page,
  }) => {
    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();

    const firstPageNames = await page
      .locator('[data-slot="card-title"]')
      .allTextContents();

    const pagination = page.getByRole("navigation", { name: "Pagination" });
    await expect(pagination).toBeVisible();
    await pagination.getByRole("link", { name: "2", exact: true }).click();

    await page.waitForURL(/[?&]page=2/);

    // The URL changes on click (client-side routing), but ProductListing
    // fetches its data in a useEffect that fires *after* that — reading
    // card titles right after waitForURL is a race that can catch the
    // still-rendered page-1 data. toHaveText's built-in polling (unlike a
    // one-shot allTextContents() read) waits until the first card's title
    // actually differs from page 1's, which is what "the new page has
    // genuinely loaded" means here. Caught this exact race live: passed
    // reliably in two different local environments (native macOS, and a
    // Linux Docker container) but failed on the first real CI run.
    await expect(
      page.locator('[data-slot="card-title"]').first(),
    ).not.toHaveText(firstPageNames[0]);

    const secondPageNames = await page
      .locator('[data-slot="card-title"]')
      .allTextContents();

    // Different page -> different products, not the same 4 re-rendered.
    expect(secondPageNames.join("|")).not.toEqual(firstPageNames.join("|"));

    await expect(page).toHaveScreenshot("home-en-page-2.png");
  });

  test("switching language updates the UI chrome without a full navigation", async ({
    page,
  }) => {
    await page.goto("/en");
    await expect(
      page.getByRole("heading", { name: "Featured listings" }),
    ).toBeVisible();

    await page
      .getByRole("combobox", { name: "Language" })
      .selectOption("hi");

    // Real Hindi string from messages/hi.json, not a guessed translation.
    await expect(
      page.getByRole("heading", { name: "विशेष लिस्टिंग" }),
    ).toBeVisible();

    await expect(page).toHaveScreenshot("home-hi.png");
  });
});

test.describe("image delivery", () => {
  test("product images are fetched from the CDN, not proxied through the origin", async ({
    page,
  }) => {
    // Verified HERE rather than in a component test, deliberately. Under
    // jsdom next/image renders the raw src regardless of `unoptimized`,
    // so a unit assertion on the rendered URL passes either way -- proven
    // by mutation testing, which showed exactly that vacuous pass. Only a
    // real build runs the optimizer, so only a real browser can tell the
    // difference.
    //
    // The bug this pins was measured on production: every product image
    // was requested as /_next/image?url=https%3A%2F%2Fimages.laxair.shop
    // -- our ORIGIN -- at ~1.86s each with cf-cache-status: DYNAMIC,
    // while the R2 edge cache sat unused.
    const imageRequests: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "image") imageRequests.push(r.url());
    });

    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
    await page.waitForLoadState("networkidle");

    const proxied = imageRequests.filter((u) => u.includes("/_next/image"));
    expect(
      proxied,
      "SVG product images must be served directly, not through the optimizer",
    ).toEqual([]);
  });
});

