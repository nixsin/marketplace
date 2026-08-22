"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { shouldBypassOptimizer } from "@/lib/image-loading";

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  deviceClass?: "A" | "B" | "C" | "D";
  certifications: string[];
  description: string;
  imageUrl?: string;
  /** Used by sitemap generation; cards do not display this value. */
  updatedAt?: string;
  seller: string;
  location: string;
}

export function ProductCard({
  product,
  priority = false,
  selected,
  onSelectedChange,
}: {
  product: Product;
  /**
   * Shortlist selection. Both optional so the card still renders standalone --
   * it is used outside the catalogue listing, and a card that required
   * selection wiring would force every caller to invent state it does not
   * need. Absent means the checkbox is not rendered at all.
   */
  selected?: boolean;
  onSelectedChange?: (productId: string) => void;
  // For the first, above-the-fold card only -- Next's <Image> defaults to
  // loading="lazy" otherwise, which a live Lighthouse audit against /hi?page=2
  // caught as the LCP image itself being lazy-loaded (lcp-discovery-insight
  // scored 0: not eagerly loaded, not fetchpriority=high, not discoverable
  // from the initial HTML). priority disables lazy-loading and sets
  // fetchpriority="high" for exactly that element.
  priority?: boolean;
}) {
  const t = useTranslations("productCard");

  return (
    <Card className="relative w-full overflow-hidden py-0">
      {onSelectedChange && (
        // Absolutely positioned over the card rather than inserted into the
        // flex row: the row's layout is load-bearing for the LCP image sizing
        // and the responsive stack, and adding a column would change both.
        //
        // A real <input type="checkbox"> with a visible <label>, not a styled
        // div with a click handler -- it has to be reachable by keyboard and
        // announced with the product's name, which is what makes "3 selected"
        // meaningful to a screen-reader user.
        <div className="absolute right-2 top-2 z-10">
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background/95 px-2 py-1 text-xs shadow-sm backdrop-blur">
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={() => onSelectedChange(product.id)}
              className="size-4 accent-primary"
              aria-label={t("selectForInquiry", { productName: product.name })}
            />
            <span aria-hidden="true">{t("select")}</span>
          </label>
        </div>
      )}
      <div className="flex flex-col sm:flex-row">
        {product.imageUrl && (
          /* The image links to the product too -- tapping a product's photo
             is the most natural way into it, especially on mobile where the
             image is the largest target on the card.

             Still NOT a whole-card link: that would nest the "Send Inquiry"
             button inside an <a>, which is invalid HTML and gives the button
             two conflicting activation behaviours.

             aria-hidden + tabIndex={-1} because this duplicates the title
             link that sits a few pixels away, pointing at the same product.
             Exposed, it would make a screen reader announce every product
             twice and add a redundant tab stop per card -- the same
             "ambiguous in aggregate" problem already fixed for this card's
             Send Inquiry button. The alt text stays on the <img> for users
             who reach the image itself. */
          <Link
            href={`/products/${product.id}`}
            aria-hidden="true"
            tabIndex={-1}
            className="relative h-48 w-full shrink-0 bg-muted transition-opacity hover:opacity-90 sm:h-auto sm:w-48"
          >
            <Image
              src={product.imageUrl}
              alt={product.name}
              fill
              sizes="(min-width: 640px) 192px, 100vw"
              className="object-cover"
              priority={priority}
              // Served straight from the CDN rather than proxied through the
              // optimizer on our origin -- see src/lib/image-loading.ts.
              unoptimized={shouldBypassOptimizer(product.imageUrl)}
            />
          </Link>
        )}

        <div className="flex flex-1 flex-col gap-(--card-spacing)">
          <CardHeader className="pt-4">
            <div className="flex items-center justify-between">
              <Badge variant="secondary">{product.category}</Badge>
              {product.deviceClass && (
                <Badge variant="outline">
                  {t("deviceClass", { class: product.deviceClass })}
                </Badge>
              )}
            </div>
            {/* leading-7 explicit: CardTitle's own base classes include
                leading-snug, but tailwind-merge silently drops it once a
                caller-supplied text-size utility (text-lg here) conflicts
                with it -- verified directly this causes h2 and div to
                render at genuinely different heights (22.5px vs 28px)
                with the exact same final class list, purely from
                tag-dependent line-height fallback once leading-snug is
                gone. leading-7 (1.75rem/28px) restores the same line
                height the div version always actually rendered at. */}
            {/* Link wraps only the heading text, not the whole Card --
                wrapping the whole card would nest the "Send Inquiry"
                button below inside an <a>, invalid HTML and a real a11y
                problem. No prefetch={false}: this is a genuinely distinct
                destination, and the route's own lack of a loading.tsx
                (see product-details/page.tsx's comment) already keeps
                Next's default scroll-into-view prefetch from triggering
                eager per-card GraphQL fetches on its own. */}
            <CardTitle asChild className="text-lg leading-7">
              <h2>
                <Link href={`/products/${product.id}`}>{product.name}</Link>
              </h2>
            </CardTitle>
            <CardDescription>
              {t("meta", {
                brand: product.brand,
                seller: product.seller,
                location: product.location,
              })}
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-1 flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {product.description}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {product.certifications.map((cert) => (
                <Badge key={cert} variant="success" className="gap-1">
                  <ShieldCheck className="size-3" />
                  {cert}
                </Badge>
              ))}
            </div>
          </CardContent>

          <CardFooter className="flex items-center justify-between py-4">
            <span className="text-sm text-muted-foreground">
              {t("priceOnRequest")}
            </span>
            {/* aria-label carries the product name; visible text stays
                short ("Send Inquiry") for sighted users. Without this,
                every card's button has the identical accessible name --
                a screen-reader user tabbing directly to a button (the
                only interactive element per card) hears "Send Inquiry,
                button" with no indication which product it's for, since
                Tab correctly skips the surrounding static title/
                description/image entirely (that's standard, expected
                browser behavior, not itself a bug) and provides no other
                context on its own. Real WCAG 2.4.4 (Link Purpose in
                Context) issue, caught by a live question about keyboard
                navigation on 2026-08-17 -- axe-core doesn't reliably
                flag ambiguous-but-technically-labeled button text like
                this, since it requires understanding intent across
                repeated elements, not just checking a rule. */}
            <Button size="sm" aria-label={t("sendInquiryAbout", { productName: product.name })}>
              {t("sendInquiry")}
            </Button>
          </CardFooter>
        </div>
      </div>
    </Card>
  );
}
