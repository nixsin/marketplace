import { unstable_cache } from "next/cache";
import { fetchProductsPaged, type ProductsPaged } from "@/lib/api";

// This repository has not enabled Next 16 Cache Components, so `use cache`
// is not available. `unstable_cache` is the documented revalidation API for
// the current mode. It keeps real product links in the initial home-page HTML
// without making every request wait for Render's API.
const getCachedInitialProducts = unstable_cache(
  (page: number) => fetchProductsPaged(page),
  ["seo-home-products-v1"],
  { revalidate: 60, tags: ["products"] },
);

export async function loadInitialProducts(
  page = 1,
): Promise<ProductsPaged | undefined> {
  try {
    return await getCachedInitialProducts(page);
  } catch {
    // ProductListing retains its existing client-side fetch path. A temporary
    // API outage must not turn a web build into an outage or remove the page
    // shell; the next request can repopulate the revalidated snapshot.
    return undefined;
  }
}

export interface SitemapProduct {
  id: string;
  updatedAt?: string;
}

export const PRODUCTS_PER_SITEMAP = 24_000;
const SITEMAP_API_PAGE_SIZE = 100;
const API_PAGES_PER_SITEMAP = PRODUCTS_PER_SITEMAP / SITEMAP_API_PAGE_SIZE;
const SITEMAP_FETCH_CONCURRENCY = 8;

export async function loadSitemapProductCount(): Promise<number> {
  return (await fetchProductsPaged(1, 1)).totalCount;
}

export async function loadSitemapProducts(
  sitemapId = 0,
): Promise<SitemapProduct[]> {
  const products: SitemapProduct[] = [];
  const firstPage = sitemapId * API_PAGES_PER_SITEMAP + 1;
  const lastPage = firstPage + API_PAGES_PER_SITEMAP - 1;
  const firstResult = await fetchProductsPaged(firstPage, SITEMAP_API_PAGE_SIZE);
  products.push(
    ...firstResult.items.map(({ id, updatedAt }) => ({ id, updatedAt })),
  );

  const finalPage = Math.min(firstResult.totalPages, lastPage);
  for (
    let batchStart = firstPage + 1;
    batchStart <= finalPage;
    batchStart += SITEMAP_FETCH_CONCURRENCY
  ) {
    const batchEnd = Math.min(
      batchStart + SITEMAP_FETCH_CONCURRENCY - 1,
      finalPage,
    );
    const results = await Promise.all(
      Array.from({ length: batchEnd - batchStart + 1 }, (_, offset) =>
        fetchProductsPaged(batchStart + offset, SITEMAP_API_PAGE_SIZE),
      ),
    );
    for (const result of results) {
      products.push(
        ...result.items.map(({ id, updatedAt }) => ({ id, updatedAt })),
      );
    }
  }

  return products;
}
