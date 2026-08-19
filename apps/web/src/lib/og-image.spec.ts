import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogImageUrl } from "./og-image";

describe("ogImageUrl", () => {
  it("swaps the seeded SVG for its PNG twin", () => {
    // The whole point: WhatsApp's scraper cannot render SVG, so a shared
    // link previewed with a blank image frame.
    expect(ogImageUrl("/products/lab-equipment.svg")).toBe("/products/lab-equipment.png");
  });

  it("leaves a real photo alone", () => {
    // Product images are placeholder illustrations today, but a seller
    // uploading an actual photo must not have its URL rewritten.
    expect(ogImageUrl("/uploads/scanner.jpg")).toBe("/uploads/scanner.jpg");
    expect(ogImageUrl("https://cdn.test/x.png")).toBe("https://cdn.test/x.png");
  });

  it("only rewrites a trailing extension, not the word 'svg' in a path", () => {
    expect(ogImageUrl("/svg-assets/photo.jpg")).toBe("/svg-assets/photo.jpg");
    expect(ogImageUrl("/products/svg.png")).toBe("/products/svg.png");
  });

  it("handles an uppercase extension, since the value is data we don't control", () => {
    expect(ogImageUrl("/products/x.SVG")).toBe("/products/x.png");
  });

  it("returns undefined for a missing image so the caller omits og:image", () => {
    // An og:image pointing at nothing previews worse than no og:image: the
    // scraper renders an empty frame rather than a clean text-only card.
    expect(ogImageUrl(null)).toBeUndefined();
    expect(ogImageUrl(undefined)).toBeUndefined();
    expect(ogImageUrl("")).toBeUndefined();
  });
});

describe("OG card dimensions", () => {
  it("matches the committed PNGs and the 1.91:1 ratio scrapers expect", () => {
    expect([OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT]).toEqual([1200, 630]);
  });
});

describe("every product SVG has the PNG twin this mapping promises", () => {
  // Without this, ogImageUrl happily rewrites `.svg` to a `.png` that was
  // never generated -- a 404 the scraper reports as a blank card, which is
  // the exact failure being fixed. Adding a sixth category SVG and
  // forgetting its PNG is the obvious way to reintroduce it, and nothing
  // else in the build would notice.
  const dir = join(process.cwd(), "public", "products");
  const svgs = readdirSync(dir).filter((f) => f.endsWith(".svg"));

  it("finds product SVGs at all (guards against the glob silently matching nothing)", () => {
    expect(svgs.length).toBeGreaterThan(0);
  });

  it.each(svgs)("%s has a PNG twin", (svg) => {
    expect(existsSync(join(dir, basename(ogImageUrl(svg)!)))).toBe(true);
  });
});
