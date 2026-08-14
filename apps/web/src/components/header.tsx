"use client";

import { useTranslations } from "next-intl";
import { Stethoscope } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "@/components/language-switcher";

// Client Component now — a direct tradeoff for instant language switching
// (see locale-provider.tsx). Header content still barely changes; what
// changed is *how* its translated strings resolve, not how often the
// content itself changes.
export function Header() {
  const t = useTranslations("header");

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        {/* prefetch={false} on all four: every one of these currently
            resolves to "/", the page already being viewed — Next.js
            can't tell that from a placeholder Link, so it would otherwise
            prefetch (and re-transmit the full locale message catalog via
            the RSC payload — see conversation) for a navigation that goes
            nowhere. Remove prefetch={false} once these have real,
            distinct destinations — at that point prefetching is the
            correct default again, not a special case. */}
        <Link href="/" prefetch={false} className="flex items-center gap-2 font-semibold">
          <Stethoscope className="size-5 text-primary" />
          <span>MedInstru Market</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <Link href="/" prefetch={false} className="hover:text-foreground">
            {t("categories")}
          </Link>
          <Link href="/" prefetch={false} className="hover:text-foreground">
            {t("sellOnMedInstru")}
          </Link>
          <Link href="/" prefetch={false} className="hover:text-foreground">
            {t("signIn")}
          </Link>
          <LanguageSwitcher />
        </nav>
      </div>
    </header>
  );
}
