"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProductCard, type Product } from "@/components/product-card";
import { fetchProductPage } from "@/lib/api";

interface ProductListProps {
  initialItems: Product[];
  initialNextCursor?: string;
}

// The first page is server-rendered (see page.tsx) for fast first paint and
// SEO-indexable content. Everything past that is loaded incrementally from
// the browser as the user scrolls — no full-page reload, no re-rendering
// the items already on screen, just an API call appending the next batch.
export function ProductList({
  initialItems,
  initialNextCursor,
}: ProductListProps) {
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchProductPage(nextCursor);
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [nextCursor, loading]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div className="flex flex-col gap-4">
      {items.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}

      <div ref={sentinelRef} className="h-8" />

      {loading && (
        <p className="text-center text-sm text-muted-foreground">
          Loading more…
        </p>
      )}
      {!nextCursor && !loading && (
        <p className="text-center text-sm text-muted-foreground">
          No more listings.
        </p>
      )}
    </div>
  );
}
