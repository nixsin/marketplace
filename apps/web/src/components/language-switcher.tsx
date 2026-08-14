"use client";

import { useTranslations } from "next-intl";
import { routing, type Locale } from "@/i18n/routing";
import { useLocaleSwitcher } from "@/components/locale-provider";

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  hi: "हिन्दी",
};

// Client Component by necessity — it's the one genuinely interactive piece
// of an otherwise static header. Uses LocaleProvider's switchLocale, not
// next-intl's router — that would re-navigate the [locale] route segment
// and hit the server on every switch, which is exactly the round trip
// this whole component exists to avoid.
export function LanguageSwitcher() {
  const t = useTranslations("languageSwitcher");
  const { locale, isSwitching, switchLocale } = useLocaleSwitcher();

  return (
    <select
      aria-label={t("label")}
      value={locale}
      disabled={isSwitching}
      onChange={(e) => switchLocale(e.target.value as Locale)}
      className="rounded-md border bg-background px-2 py-1 text-sm text-muted-foreground"
    >
      {routing.locales.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
