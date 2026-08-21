import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";

const loadInitialProducts = vi.fn();
vi.mock("@/lib/catalog-seo", () => ({
  loadInitialProducts: (page: number) => loadInitialProducts(page),
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async ({ locale }: { locale: "en" | "hi" }) => {
    const messages = locale === "hi" ? hi : en;
    return (key: keyof typeof messages.metadata) => messages.metadata[key];
  },
}));
vi.mock("@/components/home-heading", () => ({
  HomeHeading: () => <h1>Listings</h1>,
}));
vi.mock("@/components/product-listing", () => ({
  ProductListing: ({ page, initialData }: { page: number; initialData?: { items: unknown[] } }) => (
    <div data-page={page} data-items={initialData?.items.length ?? 0} />
  ),
}));

const { default: Home, generateMetadata, normalizePage } = await import("./page");

describe("home SEO", () => {
  it("passes the cached product snapshot and requested page into the rendered listing", async () => {
    loadInitialProducts.mockResolvedValue({ items: [{ id: "p1" }] });
    const tree = await Home({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ page: "2" }),
    });
    const listing = tree.props.children.props.children[1];
    expect(listing.props).toMatchObject({ page: 2, initialData: { items: [{ id: "p1" }] } });
    expect(loadInitialProducts).toHaveBeenCalledWith(2);
  });

  it("canonicalizes the first home page and declares real locale alternates", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "hi" }),
    });
    expect(metadata.alternates).toEqual({
      canonical: "/hi",
      languages: { en: "/en", hi: "/hi", "x-default": "/en" },
    });
  });

  it("self-canonicalizes pagination while dropping unrelated query parameters", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ page: "3", utm_source: "share" }),
    });
    expect(metadata.alternates?.canonical).toBe("/en?page=3");
    expect(metadata.alternates?.languages).toEqual({
      en: "/en?page=3",
      hi: "/hi?page=3",
      "x-default": "/en?page=3",
    });
  });

  it.each([
    undefined,
    "",
    "0",
    "-2",
    "1.5",
    "Infinity",
    "NaN",
    "10001",
    "1000000000000",
  ])(
    "normalizes an invalid page value (%s) to page one",
    (rawPage) => {
      expect(normalizePage(rawPage)).toBe(1);
    },
  );
});
