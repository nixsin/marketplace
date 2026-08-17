"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ProductCard, type Product } from "@/components/product-card";
import { Pagination } from "@/components/pagination";
import { fetchProductsPaged, type ProductsPaged } from "@/lib/api";

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

  // Cache of already-fetched pages, keyed by page number — a ref, not
  // state, since writing to it must never itself trigger a re-render (see
  // the prefetch effect below). Scoped to this component instance's own
  // lifetime only; no persistence, no TTL. See #75 for the design this
  // implements and its out-of-sequence-navigation edge case.
  const pageCache = useRef(new Map<number, ProductsPaged>());

  useEffect(() => {
    let cancelled = false;
    const cached = pageCache.current.get(page);

    if (cached) {
      // Already have it — either a real prior visit or (the common case)
      // a background prefetch from the previous page already finished.
      // Render immediately; no fetch, no loading state at all.
      setState({
        items: cached.items,
        totalPages: cached.totalPages,
        loading: false,
      });
      return;
    }

    // No synchronous setState(loading: true) here — react-hooks/set-state
    // -in-effect flags that as an extra render pass, and it isn't needed:
    // on the very first run `state.loading` is already true from the
    // initial useState value, and on later page changes `items.length`
    // is already > 0, so the skeleton guard below never reads it anyway.
    fetchProductsPaged(page).then((result) => {
      if (cancelled) return;
      pageCache.current.set(page, result);
      setState({
        items: result.items,
        totalPages: result.totalPages,
        loading: false,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [page]);

  // Prefetches the next page in the background once the current page has
  // actually finished loading (deliberately not before — this must never
  // compete with the fetch the user is already waiting on). Pure
  // speculation on the most likely next click; skipped entirely if
  // there's no next page, or it's already cached. If the user instead
  // navigates somewhere this didn't anticipate (a direct page-number
  // jump, a `?page=N` link, or clicking faster than a prefetch can
  // finish), the main effect above simply won't find a cache hit and
  // falls back to fetching that page fresh — the exact same path as
  // before this feature existed, not a special case.
  useEffect(() => {
    if (state.loading) return;
    const nextPage = page + 1;
    if (nextPage > state.totalPages) return;
    if (pageCache.current.has(nextPage)) return;

    let cancelled = false;
    fetchProductsPaged(nextPage).then((result) => {
      // Deliberately never calls setState — a prefetch must only warm the
      // cache, never affect what's currently on screen. If `cancelled`,
      // the user has already moved past this page before the speculative
      // fetch resolved; drop the result rather than caching data for a
      // page number that may no longer mean what it did when this fired
      // (e.g. product data changed in between).
      if (cancelled) return;
      pageCache.current.set(nextPage, result);
    });

    return () => {
      cancelled = true;
    };
  }, [page, state.loading, state.totalPages]);

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
