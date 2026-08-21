"use client";

import { useEffect, useRef, useState } from "react";
import { ProductCard, type Product } from "@/components/product-card";
import { Pagination } from "@/components/pagination";
import { Skeleton } from "@/components/skeleton";
import { fetchProductsPaged, type ProductsPaged } from "@/lib/api";

// The server supplies a short, revalidated first page so product names and
// links exist in the initial HTML for crawlers and no-JS clients. This client
// component keeps the existing responsive behavior: requested pages that
// are not already in its in-memory cache load in the browser, and the next
// likely page is prefetched after the current one settles.
export function ProductListing({
  page,
  initialData,
}: {
  page: number;
  initialData?: ProductsPaged;
}) {
  const initialPage = initialData?.page === page ? initialData : undefined;

  const [state, setState] = useState<{
    items: Product[];
    totalPages: number;
    loading: boolean;
    // Which page `items`/`totalPages` actually belong to -- distinct from
    // the `page` variable above, which is the *requested* page from the
    // URL right now. The two go out of sync for exactly one render on
    // every transition to an uncached page: `state` still holds the old
    // page's data (deliberately, see the comment below on why loading
    // isn't reset synchronously) while `page` has already moved on. An
    // AI review on PR #77 caught that the prefetch effect originally
    // trusted `state.loading`/`state.totalPages` directly during that
    // exact window -- both stale at that point, since they still describe
    // the page being navigated *away* from -- which could fire a
    // speculative fetch using the wrong page's totalPages, concurrently
    // with the real fetch for the page actually being navigated *to*,
    // contradicting the "never compete with the user's own fetch" design
    // this whole feature depends on. `state.page` is what lets the
    // prefetch effect tell "data has caught up with what's requested"
    // apart from "data just happens to say loading: false right now".
    page: number;
  }>({
    items: initialPage?.items ?? [],
    totalPages: initialPage?.totalPages ?? 1,
    loading: !initialPage,
    page: 1,
  });

  // Cache of already-fetched pages, keyed by page number — a ref, not
  // state, since writing to it must never itself trigger a re-render (see
  // the prefetch effect below). Scoped to this component instance's own
  // lifetime only; no persistence, no TTL. See #75 for the design this
  // implements and its out-of-sequence-navigation edge case.
  const pageCache = useRef(
    new Map<number, ProductsPaged>(
      initialData ? [[initialData.page, initialData]] : [],
    ),
  );

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
        page,
      });
      return;
    }

    // No synchronous setState(loading: true) here — react-hooks/set-state
    // -in-effect flags that as an extra render pass, and it isn't needed:
    // on the very first run `state.loading` is already true from the
    // initial useState value, and on later page changes `items.length`
    // is already > 0, so the skeleton guard below never reads it anyway.
    // (`state.page` still lags `page` for this one render either way --
    // see the prefetch effect below for why that's load-bearing, not
    // just an unused-looking field.)
    fetchProductsPaged(page).then((result) => {
      if (cancelled) return;
      pageCache.current.set(page, result);
      setState({
        items: result.items,
        totalPages: result.totalPages,
        loading: false,
        page,
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
  //
  // `state.page !== page` is the real guard, not `state.loading` alone —
  // on a transition to an uncached page, `state` still holds the *old*
  // page's data for one render (loading isn't reset synchronously, see
  // the main effect above), so `state.loading`/`state.totalPages` are
  // stale at exactly the moment this effect re-runs for the new `page`.
  // Trusting them directly (an earlier version of this effect did)
  // could fire a speculative fetch computed from the wrong page's
  // totalPages, racing the real fetch for the page actually being
  // navigated to — caught by review before it shipped.
  useEffect(() => {
    if (state.page !== page || state.loading) return;
    const nextPage = page + 1;
    if (nextPage > state.totalPages) return;
    if (pageCache.current.has(nextPage)) return;

    let cancelled = false;
    fetchProductsPaged(nextPage)
      .then((result) => {
        // Deliberately never calls setState — a prefetch must only warm
        // the cache, never affect what's currently on screen. If
        // `cancelled`, the user has already moved past this page before
        // the speculative fetch resolved; drop the result rather than
        // caching data for a page number that may no longer mean what it
        // did when this fired (e.g. product data changed in between).
        if (cancelled) return;
        pageCache.current.set(nextPage, result);
      })
      .catch(() => {
        // Purely speculative — a failure here must never surface as an
        // unhandled rejection or otherwise disturb the page the user is
        // actually looking at. Silently dropped; if the user does
        // navigate to `nextPage`, the main effect's cache miss falls back
        // to a completely normal fresh fetch, same as if this prefetch
        // had never run at all.
      });

    return () => {
      cancelled = true;
    };
  }, [page, state.page, state.loading, state.totalPages]);

  if (state.loading && state.items.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {state.items.map((product, index) => (
          // index 0, not page === 1 && index === 0 -- whichever page a
          // direct navigation lands on (e.g. /hi?page=2 from a shared
          // link), its first-rendered item is that load's LCP candidate,
          // not necessarily page 1's.
          <ProductCard
            key={product.id}
            product={product}
            priority={index === 0}
          />
        ))}
      </div>
      <Pagination currentPage={page} totalPages={state.totalPages} />
    </>
  );
}
