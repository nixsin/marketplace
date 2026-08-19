import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";

// Scoped to this route segment specifically -- required, not optional.
// Without it, notFound() bubbles all the way to the root app/not-found.tsx,
// which is deliberately un-localized and sits outside LocaleProvider/
// Header/Footer (it exists for genuinely unmatched routes, with no i18n
// context available). That's the wrong fallback for "this specific
// product was removed" -- a Hindi user would land on an English-only,
// chrome-less page. This file, scoped to the segment, keeps Header/
// Footer/LocaleProvider mounted (inherited from the parent layout) and
// can call getTranslations.
//
// not-found.js/global-not-found.js components don't accept any props
// (confirmed against this Next.js version's own docs) -- no `params`
// here, unlike page.tsx. getTranslations(namespace) with no explicit
// locale resolves it from the request-scoped context next-intl's routing
// already established, same mechanism Link (from @/i18n/navigation)
// below uses to prefix the right locale automatically.
export default async function ProductNotFound() {
  const t = await getTranslations("productDetails");

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
