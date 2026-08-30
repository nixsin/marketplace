import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTS_MAX_PAGE_SIZE } from '@medinstru/config';

const fetchProductsPaged = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchProductsPaged: (...args: unknown[]) => fetchProductsPaged(...args),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

const {
  loadInitialProducts,
  loadSitemapProductCount,
  loadSitemapProducts,
  SITEMAP_API_PAGE_SIZE,
} = await import("./catalog-seo");

describe("catalog SEO data", () => {
  beforeEach(() => fetchProductsPaged.mockReset());

  it("loads the first page for the server-rendered home snapshot", async () => {
    const firstPage = { items: [{ id: "p1" }], totalPages: 1 };
    fetchProductsPaged.mockResolvedValue(firstPage);
    await expect(loadInitialProducts()).resolves.toBe(firstPage);
    expect(fetchProductsPaged).toHaveBeenCalledWith(1);
  });

  it("loads a directly requested later page for server rendering", async () => {
    const thirdPage = { items: [{ id: "p3" }], page: 3, totalPages: 3 };
    fetchProductsPaged.mockResolvedValue(thirdPage);
    await expect(loadInitialProducts(3)).resolves.toBe(thirdPage);
    expect(fetchProductsPaged).toHaveBeenCalledWith(3);
  });

  it("reads the product count without downloading the catalogue", async () => {
    fetchProductsPaged.mockResolvedValue({ totalCount: 48_001 });
    await expect(loadSitemapProductCount()).resolves.toBe(48_001);
    expect(fetchProductsPaged).toHaveBeenCalledWith(1, 1);
  });

  it("paginates through every product for the sitemap", async () => {
    fetchProductsPaged
      .mockResolvedValueOnce({
        items: [{ id: "p1", updatedAt: "2026-08-19T00:00:00.000Z" }],
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        items: [{ id: "p2", updatedAt: "2026-08-20T00:00:00.000Z" }],
        totalPages: 2,
      });

    await expect(loadSitemapProducts()).resolves.toEqual([
      { id: "p1", updatedAt: "2026-08-19T00:00:00.000Z" },
      { id: "p2", updatedAt: "2026-08-20T00:00:00.000Z" },
    ]);
    expect(fetchProductsPaged).toHaveBeenNthCalledWith(1, 1, 100);
    expect(fetchProductsPaged).toHaveBeenNthCalledWith(2, 2, 100);
  });

  it("starts a later sitemap at its non-overlapping API page", async () => {
    fetchProductsPaged.mockResolvedValue({
      items: [{ id: "p24001", updatedAt: "2026-08-20T00:00:00.000Z" }],
      totalPages: 241,
    });

    await loadSitemapProducts(1);
    expect(fetchProductsPaged).toHaveBeenCalledWith(241, 100);
  });

  it("retains a product that has no modification timestamp", async () => {
    fetchProductsPaged.mockResolvedValue({
      items: [{ id: "p1" }],
      totalPages: 1,
    });
    await expect(loadSitemapProducts()).resolves.toEqual([
      { id: "p1", updatedAt: undefined },
    ]);
  });

  it("fetches later sitemap pages concurrently in bounded batches", async () => {
    let active = 0;
    let maxActive = 0;
    fetchProductsPaged.mockImplementation(async (page: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { items: [], totalPages: 10, page };
    });

    await loadSitemapProducts();
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(8);
  });

  it("fails sitemap generation rather than caching a partial success", async () => {
    fetchProductsPaged
      .mockResolvedValueOnce({
        items: [{ id: "p1", updatedAt: "2026-08-19T00:00:00.000Z" }],
        totalPages: 2,
      })
      .mockRejectedValueOnce(new Error("page 2 failed"));

    await expect(loadSitemapProducts()).rejects.toThrow("page 2 failed");
  });
});

describe("sitemap page size vs. the API's ceiling", () => {
  it("never asks for more per request than the API will serve", () => {
    // The API clamps pageSize to PRODUCTS_MAX_PAGE_SIZE silently -- it
    // returns a short page rather than an error. So a bump to
    // SITEMAP_API_PAGE_SIZE past that ceiling would truncate every shard
    // with nothing failing anywhere: the sitemap would just quietly stop
    // listing products, which is the whole feature.
    expect(SITEMAP_API_PAGE_SIZE).toBeLessThanOrEqual(PRODUCTS_MAX_PAGE_SIZE);
  });
});
