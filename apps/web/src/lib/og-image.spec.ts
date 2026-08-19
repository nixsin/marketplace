import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogImageUrl } from "./og-image";

describe("ogImageUrl", () => {
  it("swaps a managed SVG for its PNG twin", () => {
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

  it("drops an SVG we ship no twin for rather than advertising a 404", () => {
    // A seller upload or CDN-hosted SVG has no committed PNG. Rewriting it
    // would point og:image at a file that does not exist, and an empty
    // image frame previews worse than a clean text-only card.
    expect(ogImageUrl("https://cdn.test/item.svg")).toBeUndefined();
    expect(ogImageUrl("/uploads/seller-logo.svg")).toBeUndefined();
  });

  it("is not fooled by a traversal that only looks managed", () => {
    // `/products/../uploads/x.svg` passes a plain startsWith check, and
    // every consumer then resolves it to the unmanaged `/uploads/x.png` --
    // the nonexistent PNG the managed-prefix check exists to prevent,
    // smuggled straight past it.
    expect(ogImageUrl("/products/../uploads/seller-logo.svg")).toBeUndefined();
    expect(ogImageUrl("/products/sub/../../uploads/x.svg")).toBeUndefined();
  });

  it("still accepts a managed path written with a redundant segment", () => {
    expect(ogImageUrl("/products/./lab-equipment.svg")).toBe("/products/lab-equipment.png");
  });

  it("still recognises an SVG carrying a cache-busting query or fragment", () => {
    // Checking the raw string would miss the extension here and re-emit the
    // unsupported SVG -- the same bug, just harder to notice.
    expect(ogImageUrl("/products/lab-equipment.svg?v=2")).toBe(
      "/products/lab-equipment.png?v=2",
    );
    expect(ogImageUrl("/products/lab-equipment.svg#top")).toBe(
      "/products/lab-equipment.png#top",
    );
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
  it("uses the 1.91:1 ratio scrapers size their large card against", () => {
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
    expect(existsSync(join(dir, basename(ogImageUrl(`/products/${svg}`)!)))).toBe(true);
  });

  // Existence is not enough: a truncated or wrongly-sized file still passes
  // a stat check while previewing as the blank card this fixes. Read the
  // real PNG header instead of trusting the generator's exit code.
  it.each(svgs)("%s's twin is a valid PNG at the advertised size", (svg) => {
    const png = readFileSync(join(dir, basename(ogImageUrl(`/products/${svg}`)!)));

    // The 8-byte PNG signature, then the IHDR chunk: width and height are
    // big-endian uint32s at offsets 16 and 20.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(OG_IMAGE_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_IMAGE_HEIGHT);
  });
});
