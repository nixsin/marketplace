import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { loadProduct } from "@/lib/product-cache";
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

// A LITERAL, and it cannot be an import. Next parses this value out of the
// module at build time and its own docs are explicit that it "needs to be
// statically analyzable" -- `revalidate = 60 * 10` is called out as invalid,
// so `revalidate = SHARED_MAX_AGE_SECONDS` is too. That is the one place in
// this repo where a shared constant genuinely cannot be imported, so the
// coupling is pinned by a test instead (page.spec.ts), in the same shape as
// SITEMAP_API_PAGE_SIZE vs PRODUCTS_MAX_PAGE_SIZE.
//
// What it buys: the route stops being server-rendered on demand. Next emits
// `private, no-cache, no-store` for a dynamic route, which made Cloudflare's
// cache-public-html rule -- correctly set to respect_origin -- decline every
// product page. Measured against live production before this change:
// cf-cache-status BYPASS on every request, and a full origin round trip to
// Oregon for a catalogue whose buyers are in India. The CDN rule was never
// the problem; the origin was telling it not to cache.
export const revalidate = 60;

// EMPTY, and it is not a placeholder -- its presence is the whole point.
//
// Without this export Next classifies the route as Dynamic and renders it on
// demand for every request, emitting `private, no-cache, no-store`. That is
// what made Cloudflare report BYPASS on every product page in production: the
// CDN rule was right, the origin was refusing. Adding it -- even returning
// nothing -- moves the route to ISR, so an unknown id is rendered once and
// then served from the cache until `revalidate` expires.
//
// Returning [] rather than real ids is deliberate. Prerendering the catalogue
// at build would need the API reachable from CI, which it is not (the same
// constraint that keeps this route out of perf-budget.mjs), and would bake a
// snapshot of a database-backed catalogue into an image that outlives it.
// dynamicParams defaults to true, so every id is still served.
export function generateStaticParams() {
  return [];
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

  const product = await loadProduct(id);
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
  // Required here as well as in the page body, and leaving it out is what
  // kept this route dynamic. generateMetadata is its own server render pass
  // with its own request scope, so without this next-intl has no locale to
  // work from and reaches for headers() -- which, once the route is
  // prerenderable, is not a silent downgrade to dynamic any more but a hard
  // DYNAMIC_SERVER_USAGE failure.
  setRequestLocale(locale);
  // Deduped with the page body's call above, but no longer by fetch()'s
  // per-render memoization -- that keys on URL AND headers, and
  // fetchProduct mints a fresh correlation id per call, so it never
  // actually deduped these two. What dedupes them now is loadProduct's
  // cache key, which is the product id (see lib/product-cache.ts).
  const product = await loadProduct(id);
  if (!product) {
    // page.tsx's own notFound() call drives the real 404 status/UI; this
    // is just a safe, non-throwing fallback for generateMetadata's own
    // parallel resolution pass. The locale is passed explicitly even though
    // setRequestLocale ran above: this call has one to hand, and a
    // next-intl API given an explicit locale cannot fall back to headers()
    // no matter what the surrounding request scope looks like -- which is
    // the failure mode that kept this route dynamic (see not-found.tsx).
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
