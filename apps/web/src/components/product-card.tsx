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
}: {
  product: Product;
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
    <Card className="w-full overflow-hidden py-0">
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
            // See the title link below for why prefetch is off. Both links
            // point at the same product and Next dedupes them into one
            // prefetch, so this has to be set in both places or the dedupe
            // simply keeps whichever one still asks for it.
            prefetch={false}
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
              // `priority` alone does NOT produce fetchpriority="high" on
              // this version of Next, and that is the whole reason the LCP
              // image was slow. Verified in the installed source rather
              // than assumed (next@16.3.4,
              // shared/lib/get-img-props.js): `fetchPriority` is passed
              // straight through from the caller and nothing derives it
              // from `priority`, which only clears `loading="lazy"` and
              // requests a preload. The served HTML matched exactly that
              // -- first card not lazy, no fetchpriority, no preload link.
              //
              // Left at the browser's default the image loses the request
              // queue to scripts and stylesheets: production `/hi?page=2`
              // measured `resourceLoadDelay` 485 ms for an SVG that then
              // transferred in 147 ms and painted in 5 ms. The byte count
              // was never the problem; the position in the queue was.
              //
              // `undefined` rather than "auto" for the other cards, so the
              // attribute is simply absent on the ones that should stay
              // out of the way -- setting it explicitly on every card
              // would flatten the very distinction this makes.
              fetchPriority={priority ? "high" : undefined}
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
                problem.

                prefetch={false} because the prefetch was measured and it
                buys nothing. This comment previously claimed the opposite
                -- that the route's lack of a loading.tsx kept Next from
                prefetching -- which was true only while that route was
                Dynamic. #215 made it ISR, and Next prefetches a static
                route IN FULL, so three prefetches began firing on every
                listing load with nothing in the code saying so.

                They are not reused. `next-router-prefetch` participates in
                the `_rsc` hash, so a prefetch and the navigation that
                follows address different entries: measured in a real
                browser, the prefetch fetched 663 bytes under one hash and
                the click then fetched 62,914 bytes under another. Three
                requests per listing load, 307-1377ms TTFB each, discarded.

                Navigation itself is unaffected and already fast -- the RSC
                payload is edge-cached and served in ~236ms. Turning this
                off removes cost, not capability. Audited in #223, which
                also records what would have to be true to turn it back on. */}
            <CardTitle asChild className="text-lg leading-7">
              <h2>
                <Link href={`/products/${product.id}`} prefetch={false}>
                  {product.name}
                </Link>
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
