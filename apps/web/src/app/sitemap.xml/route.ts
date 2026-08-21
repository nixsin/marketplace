import { SITE_URL } from "@medinstru/config";
import {
  loadSitemapProductCount,
  PRODUCTS_PER_SITEMAP,
} from "@/lib/catalog-seo";
import { sitemapIndexXml, xmlResponse } from "@/lib/sitemap-xml";

// Do not prerender this at build time: the API may be intentionally absent
// from a web-only build environment. Successful shard responses are still
// independently revalidated; an index outage returns a retryable 5xx.
export const dynamic = "force-dynamic";

export async function GET() {
  const productCount = await loadSitemapProductCount();
  const sitemapCount = Math.max(1, Math.ceil(productCount / PRODUCTS_PER_SITEMAP));
  const urls = Array.from({ length: sitemapCount }, (_, id) =>
    new URL(`/sitemaps/${id}`, SITE_URL).toString(),
  );
  return xmlResponse(sitemapIndexXml(urls));
}
