import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  SHARED_MAX_AGE_SECONDS,
  STALE_WHILE_REVALIDATE_SECONDS,
} from "@medinstru/config";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";

// A review round (PR #94) caught generateMetadata returning a hardcoded
// English "Product not found" title even on /hi, despite messages/hi.json
// already defining productDetails.notFoundTitle -- the locale was present
// in params but never destructured. This file covers that branch, which
// had no test at all: the e2e suite exercises the rendered not-found *page*
// (which was always localized, via not-found.tsx) but never the document
// <title> generateMetadata produces.
const messages: Record<string, typeof en> = { en, hi };

// Mocks the CACHED loader the page actually calls, not fetchProduct beneath
// it: unstable_cache needs Next's request runtime, which does not exist here,
// so wrapping the mock in it would test the framework rather than the page.
const fetchProduct = vi.fn();

vi.mock("@/lib/product-cache", () => ({
  loadProduct: (id: string) => fetchProduct(id),
}));

// Resolves against the real message catalogs rather than returning the key
// back -- so this asserts the actual shipped Hindi string, not merely that
// *some* translation lookup happened.
vi.mock("next-intl/server", () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async ({
    locale,
    namespace,
  }: {
    locale: string;
    namespace: keyof typeof en;
  }) => {
    const section = messages[locale][namespace] as Record<string, string>;
    return (key: string) => section[key];
  },
}));

const { generateMetadata, productStructuredData, revalidate, generateStaticParams } =
  await import("./page");

/**
 * The two exports that make this route edge-cacheable at all.
 *
 * Neither is read by any code in this file, which is exactly why they need a
 * test: deleting either one is a silent change. The route reverts to
 * Dynamic, Next emits `private, no-cache, no-store`, Cloudflare's
 * respect_origin rule declines it, and every product page goes back to a
 * full origin round trip -- with no failing test, no build error, and
 * nothing visibly different in development, where pages are always rendered
 * on demand anyway.
 */
describe("product detail route is prerenderable", () => {
  it("revalidates on the same clock as the API tier", () => {
    // Cannot be `revalidate = SHARED_MAX_AGE_SECONDS` in page.tsx -- Next
    // requires a statically analyzable literal -- so the coupling is pinned
    // here instead, the same way SITEMAP_API_PAGE_SIZE is pinned against
    // PRODUCTS_MAX_PAGE_SIZE.
    expect(revalidate).toBe(SHARED_MAX_AGE_SECONDS);
  });

  it("exports generateStaticParams, which is what makes the route ISR", () => {
    // Its RETURN value is deliberately empty; its EXISTENCE is the load-
    // bearing part. Without the export Next never treats the route as
    // prerenderable, whatever `revalidate` says.
    expect(typeof generateStaticParams).toBe("function");
    expect(generateStaticParams()).toEqual([]);
  });

  it("keeps the stale window bounded to the API tier's", () => {
    // Next derives stale-while-revalidate as `expireTime - revalidate`, and
    // expireTime defaults to a YEAR -- measured before this was set, the page
    // shipped `stale-while-revalidate=31535940`.
    //
    // Asserted against next.config.ts's SOURCE rather than by importing it.
    // That file calls assertBootEnv at module load and is the file Next
    // loads to boot, so an ordinary test cannot import it -- the same
    // constraint that put security-headers.ts and site-url.ts in their own
    // modules. Reading the text is the idiom this repo already uses for
    // config it cannot import (see the Terraform and Dockerfile drift tests).
    const config = readFileSync(
      new URL("../../../../../next.config.ts", import.meta.url),
      "utf8",
    );
    expect(config).toMatch(
      /expireTime:\s*SHARED_MAX_AGE_SECONDS\s*\+\s*STALE_WHILE_REVALIDATE_SECONDS/,
    );
    // And that the value those two constants produce still leaves this
    // route's stale window where the API tier's is.
    const expireTime = SHARED_MAX_AGE_SECONDS + STALE_WHILE_REVALIDATE_SECONDS;
    expect(expireTime - (revalidate as number)).toBe(
      STALE_WHILE_REVALIDATE_SECONDS,
    );
    // expireTime is GLOBAL. A route whose revalidate exceeded it would get a
    // negative stale window, so the ceiling has to move with it.
    expect(revalidate as number).toBeLessThanOrEqual(expireTime);
  });
});

describe("product detail generateMetadata", () => {
  beforeEach(() => {
    fetchProduct.mockReset();
  });

  it("uses the English not-found title for /en when the product is missing", async () => {
    fetchProduct.mockResolvedValue(null);

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", id: "does-not-exist" }),
    });

    expect(metadata.title).toBe("Product not found");
  });

  it("uses the localized Hindi not-found title for /hi when the product is missing", async () => {
    fetchProduct.mockResolvedValue(null);

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "hi", id: "does-not-exist" }),
    });

    // The exact string from messages/hi.json -- asserting the real
    // translation, not just "something other than English".
    expect(metadata.title).toBe("उत्पाद नहीं मिला");
    expect(metadata.title).not.toBe("Product not found");
  });

  it("builds title/description/openGraph from a found product", async () => {
    fetchProduct.mockResolvedValue({
      id: "p1",
      name: "Portable Ultrasound",
      description: "A handheld point-of-care ultrasound system.",
      imageUrl: "/products/ultrasound.svg",
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", id: "p1" }),
    });

    expect(metadata.title).toBe("Portable Ultrasound · MedInstru Market");
    expect(metadata.description).toBe(
      "A handheld point-of-care ultrasound system.",
    );
    expect(metadata.alternates).toEqual({
      canonical: "/en/products/p1",
    });
    // The PNG twin, NOT the stored .svg: Facebook's scraper (which WhatsApp
    // shares) does not support SVG, so the shared card previewed with a
    // blank image frame -- the link appeared to work while looking broken,
    // and only on the recipient's phone. See src/lib/og-image.ts.
    expect(metadata.openGraph?.images).toEqual([
      { url: "/products/ultrasound.png", width: 1200, height: 630 },
    ]);
  });

  it("emits truthful basic Product data without invented commercial fields", () => {
    const jsonLd = productStructuredData(
      {
        id: "p1",
        name: "Portable Ultrasound",
        description: "A handheld point-of-care ultrasound system.",
        brand: "ScanTech",
        category: "Diagnostics",
        imageUrl: "/products/ultrasound.svg",
        certifications: [],
        location: "Delhi",
        updatedAt: "2026-08-20T00:00:00.000Z",
        hasInquiryContact: false,
        seller: { name: "Seller", kycStatus: "APPROVED" },
      },
      "en",
    );

    expect(jsonLd).toMatchObject({
      "@type": "Product",
      name: "Portable Ultrasound",
      brand: { "@type": "Brand", name: "ScanTech" },
      category: "Diagnostics",
      url: "http://localhost:3000/en/products/p1",
    });
    expect(jsonLd).not.toHaveProperty("offers");
    expect(jsonLd).not.toHaveProperty("aggregateRating");
    expect(jsonLd).not.toHaveProperty("gtin");
  });

  it("encodes a product id as one URL segment", () => {
    const jsonLd = productStructuredData(
      {
        id: "device/portable?#1",
        name: "Portable Monitor",
        description: "Monitor",
        brand: "MedTech",
        category: "Diagnostics",
        certifications: [],
        location: "Delhi",
        updatedAt: "2026-08-20T00:00:00.000Z",
        hasInquiryContact: false,
        seller: { name: "Seller", kycStatus: "APPROVED" },
      },
      "en",
    );

    expect(jsonLd.url).toBe(
      "http://localhost:3000/en/products/device%2Fportable%3F%231",
    );
  });

  it("gives X/Twitter the same raster image and a large card", async () => {
    fetchProduct.mockResolvedValue({
      id: "p1",
      name: "Portable Ultrasound",
      description: "A handheld point-of-care ultrasound system.",
      imageUrl: "/products/ultrasound.svg",
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", id: "p1" }),
    });

    // Metadata["twitter"] is a union of card shapes, so `card`/`images`
    // are not readable off the un-narrowed type. The assertion is on the
    // real emitted object either way.
    const twitter = metadata.twitter as { card?: string; images?: unknown };
    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.images).toEqual(["/products/ultrasound.png"]);
  });

  it("omits openGraph images entirely when the product has no image", async () => {
    fetchProduct.mockResolvedValue({
      id: "p2",
      name: "Surgical Forceps",
      description: "Stainless steel forceps.",
      imageUrl: undefined,
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", id: "p2" }),
    });

    expect(metadata.openGraph?.images).toBeUndefined();
  });
});
