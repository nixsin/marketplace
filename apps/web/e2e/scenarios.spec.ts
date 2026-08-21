import { test, expect, type Locator, type Page } from "@playwright/test";

// Layout and pipeline facts that only a real engine on a real page can
// establish, asserted against the adversarial fixture in
// apps/api/prisma/seed.ts.
//
// NO SCREENSHOTS HERE, deliberately. Everything below is a measurement --
// "this text is not clipped", "this glyph has width", "the page does not
// scroll sideways", "these cards do not overlap" -- which is true on every
// engine and every viewport. So it runs on all five browser/device projects
// for the price of a page load, and never needs a baseline regenerated.
//
// The fixture's page composition is frozen (explicit ids + descending
// createdAt), so "the no-image product is on page 1" is a stable fact
// rather than a coincidence of cuid ordering. If these locators start
// missing, check the seed's ordering before assuming a UI regression.

const PAGES = {
  longName:
    "Portable Ultrasound Scanner — US-Pro 7 with Phased-Array, Linear and Convex Probe Bundle (Cardiac / Vascular / Abdominal Imaging)",
  specialChars: 'Digital Otoscope — DO-Mini 6" S/S 316L (Reusable & Autoclavable)',
  devanagari: "इन्फ्यूजन पंप — IP-200 (सिरिंज एवं वॉल्यूमेट्रिक)",
  longToken: "Biochemistry Analyzer — BC-500 / PN-BC500-XR-2026-REV-C-ASSY-001122334455",
} as const;

/** The card whose title is exactly `name`, on whichever page it lives. */
async function cardFor(page: Page, name: string, pageNumber: number): Promise<Locator> {
  const query = pageNumber === 1 ? "" : `?page=${pageNumber}`;
  await page.goto(`/en${query}`);
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: name }) });
  await expect(card).toHaveCount(1);
  return card;
}

/** True if the element's content is wider than the box drawn for it. */
async function isClipped(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    // One pixel of slack: layout widths round differently between engines
    // without that being a defect.
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
}

// NOTE ON WHAT IS *NOT* HERE.
//
// "no image", "no device class", "no certifications" and "one badge per
// certification" are NOT tested in this file. product-card.spec.tsx already
// asserts all four against a rendered component with literal props, in
// milliseconds and with no server at all.
//
// They were briefly duplicated here, which is the mistake worth recording:
// re-asking a component question at e2e level costs Postgres, an API, a
// build and a browser to learn something already known, and gives two
// places to update when the answer changes. If a branch can be answered by
// rendering one component with props, it belongs in product-card.spec.tsx.
//
// What remains below genuinely cannot be answered there: jsdom does not
// lay out or measure text, so wrapping and glyph width need a real engine;
// and overflow and collision are properties of the page, not the card.

test.describe("content extremes", () => {
  test("wraps a very long product name instead of clipping it", async ({ page }) => {
    const card = await cardFor(page, PAGES.longName, 1);
    const title = card.locator('[data-slot="card-title"]');
    await expect(title).toBeVisible();
    expect(await isClipped(title), "the long name is clipped rather than wrapped").toBe(false);
  });

  test("renders special characters literally, without double-escaping", async ({ page }) => {
    // The failure this guards against is an ampersand or quote arriving as
    // `&amp;` / `&quot;` on screen, or -- the opposite -- markup being
    // unescaped twice into live HTML. Comparing against the exact literal
    // catches both directions.
    const card = await cardFor(page, PAGES.specialChars, 2);
    await expect(card.locator('[data-slot="card-title"]')).toHaveText(PAGES.specialChars);
  });

  test("renders a non-Latin script with real glyphs", async ({ page }) => {
    // A missing font fallback typically renders zero-width or tofu boxes,
    // so asserting the text exists is not enough -- it has to occupy space.
    const card = await cardFor(page, PAGES.devanagari, 2);
    const title = card.locator('[data-slot="card-title"]');
    await expect(title).toHaveText(PAGES.devanagari);
    const box = await title.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(20);
    expect(box?.height ?? 0).toBeGreaterThan(8);
  });

  test("does not overflow horizontally on a long unbreakable token", async ({ page }) => {
    // A 40-character part number with no spaces is the classic cause of a
    // page that scrolls sideways on a phone. This runs on the mobile
    // projects too, which is where it would actually show up.
    await cardFor(page, PAGES.longToken, 3);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      overflow.scrollWidth,
      `page scrolls sideways: ${overflow.scrollWidth}px of content in a ${overflow.innerWidth}px viewport`,
    ).toBeLessThanOrEqual(overflow.innerWidth + 1);
  });

  test("keeps a very short card from colliding with its neighbour", async ({ page }) => {
    // Cards are content-height, so a one-line description next to a
    // ten-line one is where a flex/grid mistake shows up as overlap.
    await page.goto("/en?page=3");
    const cards = page.locator('[data-slot="card"]');
    await expect(cards.first()).toBeVisible();

    const boxes = await cards.evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }),
    );
    for (let i = 1; i < boxes.length; i += 1) {
      expect(
        boxes[i].top,
        `card ${i} overlaps card ${i - 1}`,
      ).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1);
    }
  });
});
