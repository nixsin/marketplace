import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { fetchProduct } from "@/lib/api";
import { ProductDetailView } from "@/components/product-detail";
import type { ProductDetail } from "@/components/product-detail";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogImageUrl } from "@/lib/og-image";
import { SITE_URL } from "@medinstru/config/web";

interface ProductDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

export function productStructuredData(product: ProductDetail, locale: string) {
  const encodedId = encodeURIComponent(product.id);
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description,
    image: product.imageUrl
      ? new URL(product.imageUrl, SITE_URL).toString()
      : undefined,
    brand: { "@type": "Brand", name: product.brand },
    category: product.category,
    url: new URL(`/${locale}/products/${encodedId}`, SITE_URL).toString(),
  };
}

// Deliberately no loading.tsx for this route. Adding one would auto-wrap
// this page in a Suspense boundary, which silently downgrades a real
// "product not found" from an actual 404 HTTP status to a 200 (Next only
// emits the real 404 status when the notFound() check runs before
// streaming starts) -- verified against Next's own docs on this
// interaction. A conscious trade-off, not an oversight: this route also
// forgoes a route-level loading skeleton as a result.
//
// This also means the default <Link> prefetch behavior stays cheap here
// for free: per Next's docs, a dynamic route without a loading.js
// boundary is skipped from eager prefetch-on-scroll, so ProductCard's new
// link to this route won't trigger per-card GraphQL fetches just from
// scrolling past a card.
export default async function ProductDetailPage({ params }: ProductDetailPageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const product = await fetchProduct(id);
  if (!product) notFound();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(productStructuredData(product, locale)).replace(
            /</g,
            "\\u003c",
          ),
        }}
      />
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{product.name}</h1>
      <ProductDetailView product={product} />
    </div>
  );
}

export async function generateMetadata({
  params,
}: ProductDetailPageProps): Promise<Metadata> {
  const { locale, id } = await params;
  // Deduped with the fetchProduct() call in the page body above via
  // fetch()'s own request memoization (same URL/options within one
  // request lifecycle costs one network round trip, not two) -- verified
  // directly against Next's docs before relying on it.
  const product = await fetchProduct(id);
  if (!product) {
    // page.tsx's own notFound() call drives the real 404 status/UI; this
    // is just a safe, non-throwing fallback for generateMetadata's own
    // parallel resolution pass. Localized rather than a hardcoded English
    // string: generateMetadata runs outside the request-locale context the
    // page body's setRequestLocale establishes, so the locale has to be
    // passed explicitly here.
    const t = await getTranslations({ locale, namespace: "productDetails" });
    return { title: t("notFoundTitle") };
  }

  // The PNG twin, not product.imageUrl itself: the stored image is an SVG,
  // which Facebook's scraper (shared by WhatsApp) does not support, so the
  // preview card rendered with a blank image frame. See src/lib/og-image.ts.
  const ogImage = ogImageUrl(product.imageUrl);

  return {
    title: `${product.name} · MedInstru Market`,
    description: product.description,
    alternates: {
      canonical: `/${locale}/products/${encodeURIComponent(id)}`,
      // Deliberately no hreflang yet: product names/descriptions are a
      // single shared field, not translated content.
    },
    openGraph: {
      title: product.name,
      description: product.description,
      // Explicit dimensions so scrapers lay out the large 1.91:1 card
      // immediately instead of guessing, or falling back to a small
      // thumbnail while they fetch the image to measure it.
      images: ogImage
        ? [{ url: ogImage, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT }]
        : undefined,
      type: "website",
    },
    // Without this, X/Twitter falls back to a small square thumbnail.
    // Costs two tags and is the same image either way.
    twitter: {
      card: "summary_large_image",
      title: product.name,
      description: product.description,
      images: ogImage ? [ogImage] : undefined,
    },
  };
}
