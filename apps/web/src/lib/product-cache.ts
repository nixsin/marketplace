import { unstable_cache } from "next/cache";
import { SHARED_MAX_AGE_SECONDS } from "@medinstru/config";
import { fetchProduct } from "@/lib/api";
import type { ProductDetail } from "@/components/product-detail";

// Keyed on the product id, NOT on the fetch -- and that is the whole reason
// this file exists rather than a `next: { revalidate }` option on the fetch
// itself, which is the smaller-looking change and does not work here.
//
// Next's Data Cache matches a request "on its URL, method, headers, and
// body" (fetch API reference). `fetchProduct` sends
// correlationHeaders(clientRequestId) with a value minted per call, so every
// request would write a new entry and read none back. The failure is silent
// in the worst way: a 100% miss rate is indistinguishable from a cold cache,
// so it would look like it worked while costing storage and returning
// nothing. `unstable_cache` keys on this function's ARGUMENTS, which puts
// the correlation header outside the key by construction rather than by
// remembering not to add one.
//
// Same TTL as catalog-seo.ts's loadInitialProducts, deliberately: the
// listing and the detail page read the same products, and expiring them on
// different clocks would let the catalogue advertise a product the detail
// page has already stopped serving.
const getCachedProduct = unstable_cache(
  (id: string) => fetchProduct(id),
  ["product-detail-v1"],
  { revalidate: SHARED_MAX_AGE_SECONDS, tags: ["products"] },
);

/**
 * Deliberately does NOT catch. `loadInitialProducts` swallows because the
 * home page must still render its shell during an API outage; this one must
 * not, and the difference is what gets cached.
 *
 * `fetchProduct` already separates two situations that look alike and are
 * not: `null` means the API said NOT_FOUND, anything thrown means the API
 * could not answer. Before caching, collapsing them cost one visitor a wrong
 * page. With caching it is worse -- a swallowed outage returns null, the
 * page calls notFound(), and a 404 is what gets stored at the edge and
 * served to everyone for the rest of the window, including crawlers, for a
 * product that exists. A thrown error renders error.tsx and Next caches
 * nothing, which is the correct outcome for "we do not know".
 */
export function loadProduct(id: string): Promise<ProductDetail | null> {
  return getCachedProduct(id);
}
