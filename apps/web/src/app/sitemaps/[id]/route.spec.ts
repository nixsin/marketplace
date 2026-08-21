import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSitemapProducts = vi.fn();
const loadSitemapProductCount = vi.fn().mockResolvedValue(24_001);
vi.mock("@/lib/catalog-seo", () => ({
  PRODUCTS_PER_SITEMAP: 24_000,
  loadSitemapProductCount: () => loadSitemapProductCount(),
  loadSitemapProducts: (id: number) => loadSitemapProducts(id),
}));

const { GET } = await import("./route");

describe("sitemap shard route", () => {
  beforeEach(() => loadSitemapProducts.mockReset());

  it("serves a later shard without repeating locale roots", async () => {
    loadSitemapProducts.mockResolvedValue([
      { id: "p/24001", updatedAt: "2026-08-20T00:00:00.000Z" },
    ]);
    const response = await GET(new Request("http://localhost/sitemaps/1"), {
      params: Promise.resolve({ id: "1" }),
    });
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(loadSitemapProducts).toHaveBeenCalledWith(1);
    expect(xml).toContain("/en/products/p%2F24001");
    expect(xml).not.toContain("<loc>http://localhost:3000/en</loc>");
  });

  it("returns 404 for a shard beyond the current catalogue", async () => {
    const response = await GET(new Request("http://localhost/sitemaps/2"), {
      params: Promise.resolve({ id: "2" }),
    });
    expect(response.status).toBe(404);
    expect(loadSitemapProducts).not.toHaveBeenCalled();
  });

  it("rejects a malformed shard before querying the catalogue", async () => {
    loadSitemapProductCount.mockClear();
    const response = await GET(new Request("http://localhost/sitemaps/not-a-number"), {
      params: Promise.resolve({ id: "not-a-number" }),
    });
    expect(response.status).toBe(404);
    expect(loadSitemapProductCount).not.toHaveBeenCalled();
  });

  it("omits an invalid modification time instead of failing the shard", async () => {
    loadSitemapProducts.mockResolvedValue([
      { id: "p1", updatedAt: "not-a-date" },
    ]);
    const response = await GET(new Request("http://localhost/sitemaps/0"), {
      params: Promise.resolve({ id: "0" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("<lastmod>");
  });

  it("keeps a product URL when its modification time is absent", async () => {
    loadSitemapProducts.mockResolvedValue([{ id: "p1" }]);
    const response = await GET(new Request("http://localhost/sitemaps/0"), {
      params: Promise.resolve({ id: "0" }),
    });
    const xml = await response.text();
    expect(xml).toContain("/en/products/p1");
    expect(xml).not.toContain("<lastmod>");
  });
});
