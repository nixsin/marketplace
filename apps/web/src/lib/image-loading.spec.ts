import { afterEach, describe, expect, it } from "vitest";
import { blobOrigin, shouldBypassOptimizer } from "./image-loading";

describe("shouldBypassOptimizer", () => {
  it("bypasses SVGs, which the optimizer cannot improve", () => {
    // Measured on production: every product image was fetched as
    // /_next/image?url=https%3A%2F%2Fimages.laxair.shop%2F... -- the
    // ORIGIN, not the CDN -- at ~1.86s each with cf-cache-status: DYNAMIC.
    // The R2 edge cache was working and no user was reaching it.
    expect(shouldBypassOptimizer("https://images.laxair.shop/products/x.svg")).toBe(true);
    expect(shouldBypassOptimizer("/products/x.svg")).toBe(true);
  });

  it("keeps rasters optimized, because there the work is real", () => {
    // Resizing and WebP conversion are genuine work a CDN hop does not
    // replace. When sellers upload photos (#93) this is the path that
    // stops a 4MB original reaching a phone.
    expect(shouldBypassOptimizer("https://images.laxair.shop/uploads/photo.jpg")).toBe(false);
    expect(shouldBypassOptimizer("/uploads/photo.png")).toBe(false);
    expect(shouldBypassOptimizer("/uploads/photo.webp")).toBe(false);
  });

  it("recognises the extension through a query or fragment", () => {
    expect(shouldBypassOptimizer("/products/x.svg?v=2")).toBe(true);
    expect(shouldBypassOptimizer("/uploads/p.jpg?w=800")).toBe(false);
  });

  it("keeps optimizing an unrecognised URL rather than guessing", () => {
    // A signed or extensionless URL. Quietly bypassing could serve a
    // full-resolution original to a phone, so the safe default is the
    // existing behaviour.
    expect(shouldBypassOptimizer("https://cdn.example/asset/abc123")).toBe(false);
    expect(shouldBypassOptimizer("/api/image?id=7")).toBe(false);
  });

  it("handles a missing image", () => {
    expect(shouldBypassOptimizer(undefined)).toBe(false);
    expect(shouldBypassOptimizer(null)).toBe(false);
    expect(shouldBypassOptimizer("")).toBe(false);
  });

  it("is case-insensitive, since the extension is data we do not control", () => {
    expect(shouldBypassOptimizer("/products/X.SVG")).toBe(true);
    expect(shouldBypassOptimizer("/uploads/P.JPEG")).toBe(false);
  });
});

describe("blobOrigin", () => {
  const original = process.env.NEXT_PUBLIC_BLOB_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BLOB_BASE_URL;
    else process.env.NEXT_PUBLIC_BLOB_BASE_URL = original;
  });

  it("reduces a configured base URL to its origin", () => {
    // A preconnect target is an origin -- a path would be ignored, and a
    // bucket-style base URL genuinely carries one.
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = "https://images.laxair.shop/bucket/media";
    expect(blobOrigin()).toBe("https://images.laxair.shop");
  });

  it("returns null when storage is not configured", () => {
    // Not "", which would render <link rel="preconnect" href=""> and make
    // the browser resolve the hint against the current document.
    for (const value of ["", undefined]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_BLOB_BASE_URL;
      else process.env.NEXT_PUBLIC_BLOB_BASE_URL = value;
      expect(blobOrigin()).toBeNull();
    }
  });

  it("returns null rather than THROWING on an unusable value", () => {
    // Load-bearing: this is read at module load, which for the layout is
    // during static generation, so throwing here fails every page's build
    // rather than one image. A relative value also has no separate origin
    // worth a hint, so null is the correct answer and not merely a safe
    // one -- the same reasoning getApiOrigin records for the API hint.
    for (const bad of ["/uploads", "images.laxair.shop", "not a url"]) {
      process.env.NEXT_PUBLIC_BLOB_BASE_URL = bad;
      expect(blobOrigin()).toBeNull();
    }
  });
});
