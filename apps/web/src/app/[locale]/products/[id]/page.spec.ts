import { describe, expect, it, vi, beforeEach } from "vitest";
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

const fetchProduct = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchProduct: (id: string) => fetchProduct(id),
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

const { generateMetadata } = await import("./page");

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
    // The PNG twin, NOT the stored .svg: Facebook's scraper (which WhatsApp
    // shares) does not support SVG, so the shared card previewed with a
    // blank image frame -- the link appeared to work while looking broken,
    // and only on the recipient's phone. See src/lib/og-image.ts.
    expect(metadata.openGraph?.images).toEqual([
      { url: "/products/ultrasound.png", width: 1200, height: 630 },
    ]);
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
