import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it.each([
    "/products/%2e%2e/uploads/logo.svg",
    "/products/%2E%2E/uploads/logo.svg",
    "/products/..%2fuploads/logo.svg",
    "/products/..\\uploads/logo.svg",
  ])("is not fooled by the encoded traversal %s", (value) => {
    // These look managed as raw strings but a WHATWG URL consumer resolves
    // them to an unmanaged path, which is precisely the bypass the
    // normalisation exists to stop.
    expect(ogImageUrl(value)).toBeUndefined();
  });

  it("keeps an encoded delimiter encoded rather than making it live", () => {
    // Emitting the decoded path turned %3F into a real "?", so a crawler
    // requested /products/foo with a query string instead of the file.
    expect(ogImageUrl("/products/foo%3Fbar.svg")).toBe("/products/foo%3Fbar.png");
    expect(ogImageUrl("/products/foo%23bar.svg")).toBe("/products/foo%23bar.png");
    expect(ogImageUrl("/products/a%20b.svg")).toBe("/products/a%20b.png");
  });

  it("round-trips: the emitted path decodes back to the intended filename", () => {
    const emitted = ogImageUrl("/products/foo%3Fbar.svg")!;
    expect(decodeURIComponent(new URL(emitted, "https://x.test").pathname)).toBe(
      "/products/foo?bar.png",
    );
    // and the query string is genuinely empty -- nothing leaked into it
    expect(new URL(emitted, "https://x.test").search).toBe("");
  });

  describe("absolute URLs on our own blob host", () => {
    // The live regression this covers: once blob storage is configured the
    // API returns absolute R2 URLs, every product image started looking
    // like a third-party CDN, and og:image was dropped entirely. Product
    // pages lost their preview card while the home page -- which uses a
    // static local path -- kept working and hid it.
    const BLOB = "https://images.laxair.shop";
    const original = process.env.NEXT_PUBLIC_BLOB_BASE_URL;

    beforeEach(() => {
      process.env.NEXT_PUBLIC_BLOB_BASE_URL = BLOB;
      vi.resetModules();
    });
    afterEach(() => {
      if (original === undefined) delete process.env.NEXT_PUBLIC_BLOB_BASE_URL;
      else process.env.NEXT_PUBLIC_BLOB_BASE_URL = original;
      vi.resetModules();
    });

    async function freshOgImageUrl() {
      // The module reads the env var at load, so it must be re-evaluated
      // after the value changes. vi.resetModules() in beforeEach clears the
      // registry; a plain dynamic import then re-runs the module.
      //
      // Deliberately NOT `import("./og-image?query")` to bust the cache:
      // that works under Vitest but TypeScript cannot resolve the
      // specifier, and `next build` type-checks the whole project -- it
      // failed the real Docker build.
      const mod = await import("./og-image");
      return mod.ogImageUrl;
    }

    it("swaps .svg for .png on our blob host", async () => {
      const fn = await freshOgImageUrl();
      expect(fn(`${BLOB}/products/lab-equipment.svg`)).toBe(
        `${BLOB}/products/lab-equipment.png`,
      );
    });

    it("still refuses a genuinely third-party host", async () => {
      // We ship no PNG twin for someone else's CDN.
      const fn = await freshOgImageUrl();
      expect(fn("https://cdn.example/item.svg")).toBeUndefined();
    });

    it("is not fooled by a host that merely starts with ours", async () => {
      // A prefix test would accept this; origin comparison does not.
      const fn = await freshOgImageUrl();
      expect(fn("https://images.laxair.shop.evil.example/products/x.svg")).toBeUndefined();
    });

    it.each([
      "/products/%2E%2E%2Fuploads/x.svg",
      "/products/%2e%2e/uploads/x.svg",
      "/products/../uploads/x.svg",
      "/products/foo%2Fbar.svg",
    ])("refuses the encoded traversal %s on our own host", async (path) => {
      // The new absolute-URL branch initially checked the RAW pathname,
      // which bypassed the normalisation the root-relative branch already
      // had -- the same bug, reintroduced by adding a second entry point
      // and not routing it through the same check.
      const fn = await freshOgImageUrl();
      expect(fn(`${BLOB}${path}`)).toBeUndefined();
    });

    it("refuses a path outside /products/ even on our host", async () => {
      const fn = await freshOgImageUrl();
      expect(fn(`${BLOB}/uploads/seller-logo.svg`)).toBeUndefined();
    });

    it("passes a raster on our host straight through", async () => {
      const fn = await freshOgImageUrl();
      expect(fn(`${BLOB}/products/photo.jpg`)).toBe(`${BLOB}/products/photo.jpg`);
    });
  });

  it("leaves a RELATIVE path alone rather than promoting it to absolute", () => {
    // `products/x.svg` resolves against whatever page renders it. Emitting
    // `/products/x.png` would silently point metadata at a different
    // resource.
    expect(ogImageUrl("products/x.svg")).toBeUndefined();
    expect(ogImageUrl("./products/x.svg")).toBeUndefined();
  });

  it("refuses an encoded slash rather than guessing how a server reads it", () => {
    // Decoding the whole path first split this into two segments and
    // emitted a different resource. But preserving it is not obviously
    // right either: WHATWG URL keeps %2F inside the segment while many
    // servers decode it first, and that ambiguity is where `..%2fuploads`
    // hides. Every managed image is a flat filename, so declining costs
    // nothing and closes the question.
    expect(ogImageUrl("/products/foo%2Fbar.svg")).toBeUndefined();
    expect(ogImageUrl("/products/..%2fuploads/logo.svg")).toBeUndefined();
  });

  it("does not crash on a malformed percent escape", () => {
    // decodeURIComponent throws on a lone "%". Metadata generation must
    // not fail because of a bad image value; an undecodable path is simply
    // not one we manage.
    expect(() => ogImageUrl("/products/100%.svg")).not.toThrow();
    expect(ogImageUrl("/products/100%.svg")).toBeUndefined();
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

    // Header inspection alone would pass a file truncated right after
    // byte 24. Walk the actual chunk structure: every chunk's declared
    // length must land exactly on the next one, the stream must contain
    // image data, and it must terminate with IEND at the true end of file.
    const chunks: string[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.subarray(offset + 4, offset + 8).toString("ascii");
      chunks.push(type);
      offset += 12 + length; // length + type + data + CRC
    }
    expect(offset).toBe(png.length); // no truncation, no trailing garbage
    expect(chunks).toContain("IDAT");
    expect(chunks.at(-1)).toBe("IEND");
  });
});

describe("committed source is text, not binary", () => {
  // A stray NUL byte in a .ts file makes git record it as binary, so it
  // stops producing a readable diff and silently becomes unreviewable.
  // That happened to og-image.ts in this very change -- caught by review,
  // not by any tool, which is why it is now a test.
  const dir = join(process.cwd(), "src", "lib");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it.each(sources)("%s contains no NUL byte", (name) => {
    expect(readFileSync(join(dir, name)).includes(0)).toBe(false);
  });
});
