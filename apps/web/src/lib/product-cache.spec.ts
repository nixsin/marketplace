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
  // A MEMOIZING fake, not a passthrough. A passthrough records how the cache
  // was configured and proves nothing about what it is keyed on -- and what
  // it is keyed on is the entire reason this module exists rather than a
  // `next: { revalidate }` option on the fetch. This stands in for Next's
  // Data Cache closely enough to answer the one question that matters: does
  // a repeat call for the same id reach fetchProduct again, and does a
  // different id stay distinct.
  unstable_cache: (
    fn: (...args: unknown[]) => unknown,
    keyParts: string[],
    options: { revalidate?: number; tags?: string[] },
  ) => {
    cacheCalls.push({ keyParts, options });
    const store = new Map<string, unknown>();
    return (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      if (!store.has(key)) store.set(key, fn(...args));
      return store.get(key);
    };
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

  it("serves a repeat request for the same id WITHOUT calling the API again", async () => {
    // The behaviour the whole change is for. Measured against a real build
    // too (three page requests, one API call), but pinned here so a change
    // to the key -- adding a request-scoped argument, say -- fails loudly
    // instead of silently reverting to a 100% miss rate, which looks
    // identical to a cold cache.
    // Distinct ids per test on purpose: getCachedProduct is created once at
    // module load, so its store outlives any beforeEach -- which is exactly
    // how the real cache behaves, and reusing an id from another test would
    // read as a miss-count bug rather than a warm cache.
    fetchProduct.mockResolvedValue({ id: "repeat-1" });
    await loadProduct("repeat-1");
    await loadProduct("repeat-1");
    await loadProduct("repeat-1");
    expect(fetchProduct).toHaveBeenCalledTimes(1);
  });

  it("keeps DIFFERENT ids distinct", async () => {
    // The other half: a cache that dedupes everything would serve one
    // product's page for every id.
    fetchProduct.mockImplementation((id: string) => Promise.resolve({ id }));
    await expect(loadProduct("distinct-a")).resolves.toMatchObject({
      id: "distinct-a",
    });
    await expect(loadProduct("distinct-b")).resolves.toMatchObject({
      id: "distinct-b",
    });
    expect(fetchProduct).toHaveBeenCalledTimes(2);
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
    await expect(loadProduct("outage-1")).rejects.toThrow(/API is down/);
  });
});
