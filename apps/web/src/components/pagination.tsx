"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const MAX_VISIBLE_PAGES = 10;

interface PaginationProps {
  currentPage: number;
  totalPages: number;
}

// Client Component — page links still cause a real navigation/server fetch
// when clicked (that's correct: a different page number is genuinely
// different data). What moved client-side is just the "Previous"/"Next"
// label translation, so a language switch doesn't touch this either.
export function Pagination({ currentPage, totalPages }: PaginationProps) {
  const t = useTranslations("pagination");
  if (totalPages <= 1) return null;

  const capped = Math.min(totalPages, MAX_VISIBLE_PAGES);
  const pages = Array.from({ length: capped }, (_, i) => i + 1);

  return (
    <nav
      aria-label="Pagination"
      className="mt-8 flex items-center justify-center gap-1"
    >
      <PageLink page={currentPage - 1} disabled={currentPage <= 1}>
        {t("previous")}
      </PageLink>

      {pages.map((p) => (
        <PageLink key={p} page={p} active={p === currentPage}>
          {p}
        </PageLink>
      ))}

      <PageLink page={currentPage + 1} disabled={currentPage >= totalPages}>
        {t("next")}
      </PageLink>
    </nav>
  );
}

function PageLink({
  page,
  active,
  disabled,
  children,
}: {
  page: number;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const className = cn(
    "flex h-9 min-w-9 items-center justify-center rounded-md px-3 text-sm",
    active && "bg-primary text-primary-foreground",
    !active && !disabled && "text-foreground hover:bg-muted",
    disabled && "pointer-events-none text-muted-foreground/40",
  );

  if (disabled) {
    // role="link" + aria-disabled, not a bare <span> with no role at all
    // -- <a> has no native `disabled` attribute, and WAI-ARIA APG's
    // documented pattern for a disabled link is exactly this: keep the
    // original role so assistive tech still identifies it as "Previous,
    // link" (dimmed/unavailable), rather than unlabeled generic text with
    // no indication it was ever a control. Confirmed live via the real
    // accessibility tree before this fix: the disabled state showed up as
    // a completely roleless `generic "Previous"`, indistinguishable from
    // stray page text.
    return (
      <span className={className} role="link" aria-disabled="true">
        {children}
      </span>
    );
  }

  return (
    <Link
      href={`/?page=${page}`}
      className={className}
      // WAI-ARIA APG's pagination pattern: the current page's own link
      // gets aria-current="page" so a screen reader can distinguish "this
      // is a link to page 2" from "you are currently on page 2" -- purely
      // additive, no visual change (styling already comes from `active`).
      aria-current={active ? "page" : undefined}
    >
      {children}
    </Link>
  );
}
