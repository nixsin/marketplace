import { describe, expect, it } from "vitest";
import { shouldBypassOptimizer } from "./image-loading";

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
