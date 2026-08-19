"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// Error boundaries must be Client Components. Handles genuine fetch/
// network failures from fetchProduct() -- distinct from "product not
// found" (handled by this same route's not-found.tsx via notFound(),
// which never reaches here).
//
// This Next.js version's error boundary prop is named `retry`, not
// `reset` -- confirmed directly against the bundled docs for this exact
// version rather than assumed from memory (a real, version-specific
// divergence per apps/web/AGENTS.md's own warning).
export default function ProductDetailError({ retry }: { retry: () => void }) {
  const t = useTranslations("productDetails");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t("errorTitle")}</h1>
      <p className="text-muted-foreground">{t("errorMessage")}</p>
      <Button onClick={() => retry()}>{t("retry")}</Button>
    </div>
  );
}
