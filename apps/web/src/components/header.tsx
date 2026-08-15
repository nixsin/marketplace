"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Menu, Stethoscope, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "@/components/language-switcher";

// Client Component now — a direct tradeoff for instant language switching
// (see locale-provider.tsx). Header content still barely changes; what
// changed is *how* its translated strings resolve, not how often the
// content itself changes.
export function Header() {
  const t = useTranslations("header");
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinks = (
    <>
      {/* prefetch={false} on all four: every one of these currently
          resolves to "/", the page already being viewed — Next.js
          can't tell that from a placeholder Link, so it would otherwise
          prefetch (and re-transmit the full locale message catalog via
          the RSC payload — see conversation) for a navigation that goes
          nowhere. Remove prefetch={false} once these have real,
          distinct destinations — at that point prefetching is the
          correct default again, not a special case. */}
      <Link href="/" prefetch={false} className="hover:text-foreground">
        {t("categories")}
      </Link>
      <Link href="/" prefetch={false} className="hover:text-foreground">
        {t("sellOnMedInstru")}
      </Link>
      <Link href="/" prefetch={false} className="hover:text-foreground">
        {t("signIn")}
      </Link>
    </>
  );

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/" prefetch={false} className="flex items-center gap-2 font-semibold">
          <Stethoscope className="size-5 text-primary" />
          <span>MedInstru Market</span>
        </Link>

        {/* Desktop/tablet nav — hidden below sm, matches the breakpoint
            footer.tsx and product-card.tsx already use for this kind of
            layout switch. */}
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground sm:flex">
          {navLinks}
          <LanguageSwitcher />
        </nav>

        {/* Mobile trigger — the four nav items + language switcher don't
            fit a 375px viewport as a single row (measured: ~442px of
            content), so below sm they collapse into this menu instead of
            silently clipping off-screen. */}
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label={t("menu")}
          className="sm:hidden"
        >
          {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {menuOpen && (
        <nav
          id="mobile-nav"
          className="flex flex-col gap-4 border-t px-6 py-4 text-sm text-muted-foreground sm:hidden"
        >
          {navLinks}
          <LanguageSwitcher />
        </nav>
      )}
    </header>
  );
}
