import { SITE_URL } from "@medinstru/config/web";
import { routing } from "@/i18n/routing";
import {
  loadSitemapProductCount,
  loadSitemapProducts,
  PRODUCTS_PER_SITEMAP,
} from "@/lib/catalog-seo";
import { urlSetXml, xmlResponse, type SitemapUrl } from "@/lib/sitemap-xml";

export const revalidate = 3600;

function validLastModified(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sitemapId = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(sitemapId) || sitemapId < 0) {
    return new Response("Not Found", { status: 404 });
  }
  const productCount = await loadSitemapProductCount();
  const sitemapCount = Math.max(1, Math.ceil(productCount / PRODUCTS_PER_SITEMAP));
  if (sitemapId >= sitemapCount) {
    return new Response("Not Found", { status: 404 });
  }

  const absolute = (path: string) => new URL(path, SITE_URL).toString();
  const entries: SitemapUrl[] = [];

  if (sitemapId === 0) {
    entries.push(
      ...routing.locales.map((locale) => ({
        url: absolute(`/${locale}`),
        changeFrequency: "daily" as const,
        priority: 1,
        alternates: {
          en: absolute("/en"),
          hi: absolute("/hi"),
          "x-default": absolute("/en"),
        },
      })),
    );
  }

  const products = await loadSitemapProducts(sitemapId);
  entries.push(
    ...products.flatMap((product) =>
      routing.locales.map((locale) => ({
        url: absolute(
          `/${locale}/products/${encodeURIComponent(product.id)}`,
        ),
        lastModified: validLastModified(product.updatedAt),
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
    ),
  );

  return xmlResponse(urlSetXml(entries));
}
