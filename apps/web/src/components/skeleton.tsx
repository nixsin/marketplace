import { cn } from "@/lib/utils";

// Extracted once this loading-state block hit a third verbatim occurrence
// (page.tsx and product-listing.tsx already duplicated it identically) --
// not preemptive, this repo's own convention is to extract on real
// repetition, not in anticipation of it.
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-muted", className)} />;
}
