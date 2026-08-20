"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { newPageView } from "@/lib/correlation";

/**
 * Starts a new page-view scope on every client-side navigation.
 *
 * Without this, `pageViewId` is module-scoped and therefore created once
 * per document load -- so after hydration this app never starts a new one,
 * because next-intl routing navigates without reloading the document.
 * Every request for the rest of the visit would share a single page-view
 * id, which is precisely the opposite of the "one per navigation" contract
 * the correlation module documents. Correlation would still work at the
 * session level, but "which navigation caused this" -- the question a page
 * view exists to answer -- would be unanswerable.
 *
 * Deliberately skips the FIRST run. The initial page view is created
 * lazily by getPageViewId() when the first request needs it; minting
 * another here would discard it and split one navigation across two ids.
 */
export function PageViewTracker() {
  const pathname = usePathname();
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    newPageView();
  }, [pathname]);

  return null;
}
