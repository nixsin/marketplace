import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SHARED_MAX_AGE_SECONDS } from "@medinstru/config";

/**
 * What this module has to get right is not "does it return the product" --
 * it is what it is keyed on and what it refuses to swallow. Both are
 * invisible at runtime when wrong: a cache keyed on something request-scoped
 * simply never hits, which looks exactly like a cold cache, and a swallowed
 * outage returns null, which looks exactly like a product that was removed.
 */
const cacheCalls: Array<{
  keyParts: string[];
  options: { revalidate?: number; tags?: string[] };
}> = [];

const fetchProduct = vi.fn();

vi.mock("next/cache", () => ({
  // Records how the cache was configured and otherwise passes through, so
  // the assertions below are about this module's own choices rather than
  // about Next's caching implementation.
  unstable_cache: (
    fn: (...args: unknown[]) => unknown,
    keyParts: string[],
    options: { revalidate?: number; tags?: string[] },
  ) => {
    cacheCalls.push({ keyParts, options });
    return fn;
  },
}));

vi.mock("@/lib/api", () => ({
  fetchProduct: (id: string) => fetchProduct(id),
}));

const { loadProduct } = await import("./product-cache");

describe("loadProduct", () => {
  beforeEach(() => {
    fetchProduct.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expires on the same clock as the API tier and the home page", () => {
    // The listing and the detail page read the same catalogue. Different
    // TTLs let one advertise a product the other has stopped serving.
    expect(cacheCalls[0]?.options.revalidate).toBe(SHARED_MAX_AGE_SECONDS);
  });

  it("is tagged so a future on-demand purge can reach it", () => {
    expect(cacheCalls[0]?.options.tags).toContain("products");
  });

  it("passes the id through as the cache argument", async () => {
    // The whole reason this module exists instead of a `next: { revalidate }`
    // option on the fetch. fetchProduct sends a fresh correlation id header
    // per call, and Next's Data Cache matches on headers -- so a fetch-level
    // cache would write a new entry every request and read none back.
    // Keying on the argument puts that header outside the key.
    fetchProduct.mockResolvedValue({ id: "p1" });
    await loadProduct("p1");
    expect(fetchProduct).toHaveBeenCalledWith("p1");
  });

  it("returns null for a product the API says is gone", async () => {
    fetchProduct.mockResolvedValue(null);
    await expect(loadProduct("gone")).resolves.toBeNull();
  });

  it("RETHROWS an API failure instead of reporting it as a missing product", async () => {
    // The one that matters most under caching. If this swallowed like
    // loadInitialProducts does, an outage would return null, the page would
    // call notFound(), and a 404 for a product that exists would be written
    // to the edge and served to everyone -- crawlers included -- for the
    // rest of the window. A throw renders error.tsx and caches nothing.
    fetchProduct.mockRejectedValue(new Error("API is down"));
    await expect(loadProduct("p1")).rejects.toThrow(/API is down/);
  });
});
