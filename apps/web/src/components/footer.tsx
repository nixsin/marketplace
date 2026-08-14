"use client";

import { useTranslations } from "next-intl";

export function Footer() {
  const t = useTranslations("footer");

  return (
    <footer className="border-t bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>{t("rights", { year: new Date().getFullYear() })}</p>
        <div className="flex gap-4">
          <span>{t("about")}</span>
          <span>{t("contact")}</span>
          <span>{t("terms")}</span>
          <span>{t("privacy")}</span>
        </div>
      </div>
    </footer>
  );
}
