import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/catalog-seo", () => ({
  PRODUCTS_PER_SITEMAP: 24_000,
  loadSitemapProductCount: vi.fn().mockResolvedValue(24_001),
}));

const { GET } = await import("./route");

describe("sitemap index route", () => {
  it("partitions before a shard can exceed 50,000 localized URLs", async () => {
    const response = await GET();
    const xml = await response.text();
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(xml).toContain("http://localhost:3000/sitemaps/0");
    expect(xml).toContain("http://localhost:3000/sitemaps/1");
  });
});
