"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { Share2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  productShareMessage,
  productShareUrl,
  whatsappShareHref,
} from "@/lib/whatsapp";

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

      <p className="text-base leading-relaxed text-muted-foreground">
        {product.description}
      </p>

      {/* Share, not inquire (issue #91). This opens WhatsApp's contact
          picker so the sharer chooses the recipient -- forwarding a listing
          to a colleague or procurement group is how B2B buying decisions
          actually circulate in this market. The seller-directed inquiry
          flow needs a seller contact number, which neither the schema nor
          the "whose number" decision provides yet.

          A real <a> rather than a click handler: it must survive the page
          being opened from a cold WhatsApp link on a slow connection,
          before hydration completes. */}
      <div>
        <Button asChild variant="outline" className="gap-2">
          <a
            href={whatsappShareHref(
              productShareMessage(product.name, productShareUrl(product.id, locale)),
            )}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("shareAbout", { productName: product.name })}
          >
            <Share2 className="size-4" />
            {t("shareOnWhatsApp")}
          </a>
        </Button>
      </div>

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
