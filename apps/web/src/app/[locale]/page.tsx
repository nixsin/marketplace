import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { HomeHeading } from "@/components/home-heading";
import { ProductListing } from "@/components/product-listing";
import { loadInitialProducts } from "@/lib/catalog-seo";

interface HomeProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Numbered offset pagination is not the long-term catalogue architecture
// (TECHNICAL_PLAN.md §12B). Bound it so arbitrary query strings cannot create
// unbounded server cache keys or enormous database offsets in the meantime.
export const MAX_CATALOG_PAGE = 10_000;

export function normalizePage(rawPage: string | string[] | undefined): number {
  const value = Number(Array.isArray(rawPage) ? rawPage[0] : rawPage);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CATALOG_PAGE
    ? value
    : 1;
}

export default async function Home({ params, searchParams }: HomeProps) {
  const { locale } = await params;
  const requestedPage = normalizePage((await searchParams)?.page);
  setRequestLocale(locale);
  const initialProducts = await loadInitialProducts(requestedPage);

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-3xl">
        <HomeHeading />
        <ProductListing page={requestedPage} initialData={initialProducts} />
      </div>
    </div>
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: HomeProps): Promise<Metadata> {
  const { locale } = await params;
  const page = normalizePage((await searchParams)?.page);
  const pageQuery = page > 1 ? `?page=${page}` : "";
  const t = await getTranslations({ locale, namespace: "metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: {
      // Pagination contains distinct products, so later pages self-reference.
      // All unrelated query parameters are deliberately omitted.
      canonical: `/${locale}${pageQuery}`,
      // The home-page catalogue data is shared, but the surrounding page
      // content is genuinely translated in both locales.
      languages: {
        en: `/en${pageQuery}`,
        hi: `/hi${pageQuery}`,
        "x-default": `/en${pageQuery}`,
      },
    },
  };
}
