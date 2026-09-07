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
  } catch (error) {
    // REPORTED, not just swallowed. Returning undefined is correct -- an API
    // outage must not remove the page shell -- but it degrades the thing this
    // whole path exists for: real product names and links in the initial HTML
    // for crawlers. Silently, and for as long as the outage lasts. The catch
    // stays; what changes is that it says so.
    //
    // console.error rather than reportApiFailure: this runs on the server with
    // no Response and no client id, so the correlation pair does not apply.
    console.error(
      JSON.stringify({
        msg: "initial catalogue unavailable — home page will render without product links",
        page,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    // ProductListing retains its existing client-side fetch path. A temporary
    // API outage must not turn a web build into an outage or remove the page
    // shell; the next request can repopulate the revalidated snapshot.
    return undefined;
  }
}

interface SitemapProduct {
  id: string;
  updatedAt?: string;
}

export const PRODUCTS_PER_SITEMAP = 24_000;
// Exported so a test can assert it never exceeds the API's own
// PRODUCTS_MAX_PAGE_SIZE. The API clamps silently, so a bump here
// past that ceiling would truncate every sitemap shard without any
// error -- the shards would simply go short and nobody would notice.
export const SITEMAP_API_PAGE_SIZE = 100;
const API_PAGES_PER_SITEMAP = PRODUCTS_PER_SITEMAP / SITEMAP_API_PAGE_SIZE;
const SITEMAP_FETCH_CONCURRENCY = 8;

export async function loadSitemapProductCount(): Promise<number> {
  return (await fetchProductsPaged(1, 1)).totalCount;
}

export async function loadSitemapProducts(
  sitemapId = 0,
): Promise<SitemapProduct[]> {
  const products: SitemapProduct[] = [];

  // Every entry must have a real id, because the caller turns it straight into
  // a URL. An item without one yields `/products/undefined` -- a link to a
  // page that 404s, published to crawlers as though it were a product. Failing
  // is the right answer: this repo already refuses to publish a sitemap it
  // cannot complete rather than publishing a wrong one.
  const usable = (result: ProductsPaged, page: number): SitemapProduct[] =>
    result.items.map(({ id, updatedAt }) => {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(
          `loadSitemapProducts: product on page ${page} has no usable id`,
        );
      }
      return { id, updatedAt };
    });
  const firstPage = sitemapId * API_PAGES_PER_SITEMAP + 1;
  const lastPage = firstPage + API_PAGES_PER_SITEMAP - 1;
  const firstResult = await fetchProductsPaged(firstPage, SITEMAP_API_PAGE_SIZE);
  products.push(...usable(firstResult, firstPage));

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
    results.forEach((result, offset) => {
      products.push(...usable(result, batchStart + offset));
    });
  }

  return products;
}
