"use client";

import { useTranslations } from "next-intl";

// Split out from page.tsx so this text can react to a client-side locale
// switch — page.tsx itself must stay a Server Component (it fetches data
// from searchParams), but its two static strings don't need to.
export function HomeHeading() {
  const t = useTranslations("home");

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        {t("title")}
      </h1>
      <p className="mb-8 text-sm text-muted-foreground">{t("subtitle")}</p>
    </>
  );
}
