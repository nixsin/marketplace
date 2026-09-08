"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";

// Scoped to this route segment specifically -- required, not optional.
// Without it, notFound() bubbles all the way to the root app/not-found.tsx,
// which is deliberately un-localized and sits outside LocaleProvider/
// Header/Footer (it exists for genuinely unmatched routes, with no i18n
// context available). That's the wrong fallback for "this specific
// product was removed" -- a Hindi user would land on an English-only,
// chrome-less page. This file, scoped to the segment, keeps Header/
// Footer/LocaleProvider mounted (inherited from the parent layout).
//
// "use client" with useTranslations, NOT a Server Component with
// getTranslations, and the reason is structural rather than stylistic.
// not-found.js components accept no props -- confirmed against this Next.js
// version's own docs -- so there is no `params` here and therefore no locale
// to hand to a server-side next-intl call, and no way to call
// setRequestLocale either. A bare `getTranslations("productDetails")` works
// anyway under dynamic rendering, because next-intl falls back to reading
// headers() for the locale. That fallback is exactly what kept this route
// from ever being prerenderable: once the route became static, the same call
// threw DYNAMIC_SERVER_USAGE ("couldn't be rendered statically because it
// used `headers`") and every product page returned a 500, including the ones
// that were never missing.
//
// As a Client Component the locale and messages come from
// NextIntlClientProvider, which the parent layout already resolves
// statically after setRequestLocale -- no headers(), nothing request-scoped.
// error.tsx beside this file has always been a Client Component for its own
// reasons, so the two boundaries now resolve their strings the same way.
export default function ProductNotFound() {
  const t = useTranslations("productDetails");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t("notFoundTitle")}</h1>
      <p className="text-muted-foreground">{t("notFoundMessage")}</p>
      <Button asChild>
        <Link href="/">{t("backToListing")}</Link>
      </Button>
    </div>
  );
}
