"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import { useSyncExternalStore } from "react";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { InquiryForm } from "@/components/inquiry-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  productShareMessage,
  productShareUrl,
  whatsappShareHref,
} from "@/lib/whatsapp";
import { shouldBypassOptimizer } from "@/lib/image-loading";

export interface ProductDetail {
  id: string;
  name: string;
  brand: string;
  category: string;
  deviceClass?: "A" | "B" | "C" | "D";
  certifications: string[];
  location: string;
  description: string;
  imageUrl?: string;
  // Category-specific specs -- schema-agnostic on purpose, see the API's
  // own Product.details comment. Rendered as a plain key/value list below;
  // not the full per-category attribute-schema system from
  // TECHNICAL_PLAN.md §6, deliberately deferred.
  details?: Record<string, unknown>;
  updatedAt: string;
  /**
   * Whether an inquiry can actually reach this seller (#91). The seller's
   * WhatsApp number itself is never sent to the browser -- the send happens
   * server-side -- so a scraper cannot harvest seller numbers by loading
   * product pages. Story 6 is explicit about not exposing seller staff to
   * unsolicited contact.
   */
  hasInquiryContact: boolean;
  seller: {
    name: string;
    gstin?: string;
    kycStatus: "PENDING" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";
  };
}

// "use client" deliberately, unlike a plain getTranslations server
// component: this app's LocaleProvider lets every page's UI text react
// live to a language switch without a hard reload (see
// language-switcher.tsx/locale-provider.tsx), and ProductCard already
// follows this same pattern for exactly that reason. A pure-server
// version would leave this page's labels stuck in the old locale after a
// live switch -- a real, visible regression versus existing site
// behavior. The initial HTML is still fully server-rendered regardless
// (React Server Components SSR client components' output too); this only
// affects hydration, not what ships in the first response -- product(id)
// itself is fetched server-side, in page.tsx, before this component ever
// runs.
const KYC_BADGE_VARIANT: Record<
  ProductDetail["seller"]["kycStatus"],
  "success" | "warning" | "destructive"
> = {
  APPROVED: "success",
  PENDING: "warning",
  UNDER_REVIEW: "warning",
  REJECTED: "destructive",
};

// `details` is unconstrained JSON (see the field's own comment above), so a
// value can be a nested object/array, not just a primitive. String(value) on
// those produces the literal text "[object Object]" -- JSON.stringify gives
// a readable, if inelegant, fallback instead. Deliberately not a fuller
// nested-rendering treatment (recursive lists, etc.) -- this is a stopgap
// for a shape the UI doesn't have a real design for yet, not a shape any
// current uploader actually produces.
function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function ProductDetailView({ product }: { product: ProductDetail }) {
  const t = useTranslations("productDetails");
  const locale = useLocale();

  const detailEntries = product.details ? Object.entries(product.details) : [];

  // The share URL is built against the browser's real origin once hydrated.
  // The build-time SITE_URL is only a server-render fallback, and it was
  // wrong in production -- NEXT_PUBLIC_SITE_URL was never set on the
  // deployed service, so every shared link pointed at http://localhost:3000.
  // A runtime origin cannot be misconfigured: it is the host the sharer is
  // looking at.
  // useSyncExternalStore, not useState+useEffect: setState inside an effect
  // triggers a cascading render (ESLint's react-hooks/set-state-in-effect
  // rejects it), and reading window.location directly during render would
  // produce different server and client output -- a hydration mismatch.
  // This hook exists precisely to read an external value with distinct
  // server and client snapshots. Nothing to subscribe to: the origin cannot
  // change for the lifetime of the page.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => undefined,
  );

  return (
    <div className="flex flex-col gap-6">
      {product.imageUrl && (
        <div className="relative h-64 w-full overflow-hidden rounded-xl bg-muted sm:h-96">
          <Image
            src={product.imageUrl}
            alt={product.name}
            fill
            sizes="(min-width: 640px) 768px, 100vw"
            className="object-cover"
            // This is very likely the LCP element on a standalone product
            // page -- same reasoning as ProductCard's own priority prop.
            priority
            // Served straight from the CDN rather than proxied through the
            // optimizer on our origin -- see src/lib/image-loading.ts.
            unoptimized={shouldBypassOptimizer(product.imageUrl)}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{product.category}</Badge>
        {product.deviceClass && (
          <Badge variant="outline">
            {t("deviceClass", { class: product.deviceClass })}
          </Badge>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        {t("brandLocation", { brand: product.brand, location: product.location })}
      </p>

      {/* Share, not inquire (issue #91). This opens WhatsApp's contact
          picker so the sharer chooses the recipient -- forwarding a listing
          to a colleague or procurement group is how B2B buying decisions
          actually circulate in this market. The seller-directed inquiry
          form is the block below, and the two are not interchangeable:
          this one hands the message to whoever the BUYER picks, that one
          records a question for the SELLER.

          A real <a> rather than a click handler: it must survive the page
          being opened from a cold WhatsApp link on a slow connection,
          before hydration completes. */}
      <div className="order-first sm:order-none">
        {/* Green with a WHITE mark and white text -- WhatsApp's own lockup,
            which is what makes the button recognisable at a glance before
            anyone reads it.

            The exact green is the one real compromise here, and it was
            measured, not eyeballed. WhatsApp's signature #25D366 cannot
            carry white text accessibly: white on it is 1.98:1 against WCAG
            AA's 4.5:1 for normal text. That is not a rule this repo can
            wave through -- it runs axe in CI and has already fixed 3.65:1
            and 4.02:1 failures (see CLAUDE.md's contrast audit). Every
            other official WhatsApp colour fails white too (#1DA851 3.10,
            their teal #128C7E 4.14); the only one that passes is the dark
            teal #075E54, which stops reading as green at all.

            So: a deep WhatsApp-family green at 5.42:1. Keeps the white
            lockup and the green identity, and passes. The earlier attempt
            kept #25D366 exactly and darkened the TEXT instead, which
            passed at 10.59:1 but looked nothing like a WhatsApp button --
            brand recognition is the entire reason for using the colour. */}
        <Button
          asChild
          size="lg"
          className="w-full gap-2 text-base shadow-sm sm:w-auto bg-[#0F7A3D] text-white hover:bg-[#0C6531] focus-visible:ring-[#25D366]/50"
        >
          <a
            href={whatsappShareHref(
              productShareMessage(product.name, productShareUrl(product.id, locale, origin)),
            )}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("shareAbout", { productName: product.name })}
          >
            {/* size-6, not size-5: at the smaller size the mark's bubble
                outline thins out enough to read as a generic circle. */}
            <WhatsAppIcon className="size-6" />
            {t("shareOnWhatsApp")}
          </a>
        </Button>
      </div>

      {/* Rendered only when the seller can actually be reached.
          hasInquiryContact is a BOOLEAN, deliberately -- the seller's number
          is never sent to the browser, so a scraper cannot harvest numbers by
          loading product pages (#91 story 6).

          Hidden rather than shown-and-failing when it is false: a form that
          takes a buyer's question and has nowhere to send it is worse than no
          form, because the buyer believes they have asked. */}
      {product.hasInquiryContact && (
        <InquiryForm productId={product.id} productName={product.name} />
      )}

      <p className="text-base leading-relaxed text-muted-foreground">
        {product.description}
      </p>


      {product.certifications.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {product.certifications.map((cert) => (
            <Badge key={cert} variant="success" className="gap-1">
              <ShieldCheck className="size-3" />
              {cert}
            </Badge>
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold tracking-tight">
          {t("specifications")}
        </h2>
        {detailEntries.length > 0 ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {detailEntries.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4 border-b py-1.5 text-sm">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="text-right font-medium">{formatDetailValue(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noSpecifications")}</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold tracking-tight">{t("seller")}</h2>
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{product.seller.name}</p>
          {product.seller.gstin && (
            <p className="text-muted-foreground">
              {t("gstin", { gstin: product.seller.gstin })}
            </p>
          )}
          <div>
            <Badge variant={KYC_BADGE_VARIANT[product.seller.kycStatus]}>
              {t("sellerVerification", { status: product.seller.kycStatus })}
            </Badge>
          </div>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        {t("lastUpdated", {
          // timeZone is pinned to UTC deliberately: this is a "use client"
          // component, so the date string computed during SSR (server's
          // timezone) must exactly match what the browser recomputes during
          // hydration (viewer's local timezone), or React throws a
          // hydration mismatch. A timestamp near a day boundary (e.g.
          // 23:37 UTC) genuinely renders a different calendar date in IST
          // (UTC+5:30) than in UTC -- pinning both renders to the same
          // fixed zone removes the mismatch entirely. Trades "shows the
          // viewer's local date" for "shows a stable, correct date" --
          // acceptable for a last-updated indicator, which doesn't need
          // viewer-local precision.
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeZone: "UTC",
          }).format(new Date(product.updatedAt)),
        })}
      </p>
    </div>
  );
}
