import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { fetchProduct } from "@/lib/api";
import { ProductDetailView } from "@/components/product-detail";

interface ProductDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
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
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{product.name}</h1>
      <ProductDetailView product={product} />
    </div>
  );
}

export async function generateMetadata({
  params,
}: ProductDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  // Deduped with the fetchProduct() call in the page body above via
  // fetch()'s own request memoization (same URL/options within one
  // request lifecycle costs one network round trip, not two) -- verified
  // directly against Next's docs before relying on it.
  const product = await fetchProduct(id);
  if (!product) {
    // page.tsx's own notFound() call drives the real 404 status/UI; this
    // is just a safe, non-throwing fallback for generateMetadata's own
    // parallel resolution pass.
    return { title: "Product not found" };
  }

  return {
    title: `${product.name} · MedInstru Market`,
    description: product.description,
    openGraph: {
      title: product.name,
      description: product.description,
      images: product.imageUrl ? [{ url: product.imageUrl }] : undefined,
    },
  };
}
