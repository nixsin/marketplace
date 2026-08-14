import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { HomeHeading } from "@/components/home-heading";
import { ProductListing } from "@/components/product-listing";

interface HomeProps {
  params: Promise<{ locale: string }>;
}

// Fully static per locale now — no server-side data fetching, no
// searchParams read here. See product-listing.tsx for why the actual
// catalog data was moved out of this render entirely.
export default async function Home({ params }: HomeProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-3xl">
        <HomeHeading />
        <Suspense
          fallback={
            <div className="flex flex-col gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-48 w-full animate-pulse rounded-xl bg-muted"
                />
              ))}
            </div>
          }
        >
          <ProductListing />
        </Suspense>
      </div>
    </div>
  );
}
