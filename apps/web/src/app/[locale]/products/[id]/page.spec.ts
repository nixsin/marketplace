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
      imageUrl: "/images/ultrasound.svg",
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", id: "p1" }),
    });

    expect(metadata.title).toBe("Portable Ultrasound · MedInstru Market");
    expect(metadata.description).toBe(
      "A handheld point-of-care ultrasound system.",
    );
    expect(metadata.openGraph?.images).toEqual([
      { url: "/images/ultrasound.svg" },
    ]);
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
