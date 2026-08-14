import { ProductList } from "@/components/product-list";
import { fetchProductPage } from "@/lib/api";

// ISR: regenerate the SSR'd first page in the background at most once every
// 30s, instead of freezing catalog data at build time forever.
export const revalidate = 30;

export default async function Home() {
  const firstPage = await fetchProductPage();

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-3xl">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">
          Featured listings
        </h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Live from the catalog — MedInstru Market
        </p>
        <ProductList
          initialItems={firstPage.items}
          initialNextCursor={firstPage.nextCursor}
        />
      </div>
    </div>
  );
}
