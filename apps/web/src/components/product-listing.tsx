"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ProductCard, type Product } from "@/components/product-card";
import { Pagination } from "@/components/pagination";
import { fetchProductsPaged } from "@/lib/api";

// Items for sale are fetched independently of the page shell — on mount,
// and again whenever ?page changes — rather than being baked into the
// server render of the page itself. Two reasons this split matters:
//
// 1. Product data is genuinely dynamic (new listings, price/description
//    edits) and should never be treated as "safe to cache alongside the
//    shell" — it needs to reflect current DB state on every load.
// 2. The shell (header/footer/title, translated UI chrome) has no such
//    requirement — it barely ever changes. Keeping its data-fetching out
//    of page.tsx entirely is what lets Next.js prerender the shell as a
//    static, cacheable route again (searchParams read here, client-side,
//    doesn't taint the server render the way reading it in a Server
//    Component does) — see page.tsx.
export function ProductListing() {
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [state, setState] = useState<{
    items: Product[];
    totalPages: number;
    loading: boolean;
  }>({ items: [], totalPages: 1, loading: true });

  useEffect(() => {
    let cancelled = false;

    // No synchronous setState(loading: true) here — react-hooks/set-state
    // -in-effect flags that as an extra render pass, and it isn't needed:
    // on the very first run `state.loading` is already true from the
    // initial useState value, and on later page changes `items.length`
    // is already > 0, so the skeleton guard below never reads it anyway.
    fetchProductsPaged(page).then(({ items, totalPages }) => {
      if (cancelled) return;
      setState({ items, totalPages, loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [page]);

  if (state.loading && state.items.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-48 w-full animate-pulse rounded-xl bg-muted"
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {state.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
      <Pagination currentPage={page} totalPages={state.totalPages} />
    </>
  );
}
