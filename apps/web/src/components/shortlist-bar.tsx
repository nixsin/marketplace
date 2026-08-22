"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import {
  INQUIRY_BULK_MAX_PRODUCTS,
  INQUIRY_MESSAGE_MAX_LENGTH,
  INQUIRY_NAME_MAX_LENGTH,
} from "@medinstru/config";
import { submitBundleInquiry } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";

type Status = "idle" | "open" | "sending" | "sent" | "error";

/**
 * Shortlist a few products from the catalogue and ask about all of them at
 * once — one message to the seller rather than one per item.
 *
 * The bar is fixed to the bottom of the viewport rather than placed in the
 * flow: a buyer selects while scrolling, and a submit control that scrolls
 * away is one they have to hunt for after making the decision to use it.
 *
 * Renders nothing at all when nothing is selected, so a visitor who never
 * shortlists pays no layout, no focus stop and no announcement for it.
 */
export function ShortlistBar({
  productIds,
  onClear,
}: {
  productIds: string[];
  onClear: () => void;
  /** Present for symmetry with the card's toggle; the bar removes via clear. */
  onRemove?: (productId: string) => void;
}) {
  const t = useTranslations("shortlist");
  const formId = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [skipped, setSkipped] = useState<number>(0);
  const [sellers, setSellers] = useState<number>(0);

  if (productIds.length === 0) return null;

  const overLimit = productIds.length > INQUIRY_BULK_MAX_PRODUCTS;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setStatus("sending");

    const result = await submitBundleInquiry({
      productIds,
      buyerName: String(data.get("buyerName") ?? "").trim(),
      buyerPhone: String(data.get("buyerPhone") ?? "").trim(),
      message: String(data.get("message") ?? "").trim(),
    });

    if (result.ok) {
      // Surfaced rather than swallowed: the buyer deliberately selected these,
      // so silently dropping the ones they asked about too recently would look
      // like the feature losing their input.
      setSkipped(result.skippedCount);
      // A shortlist spanning sellers becomes one message each. "Sent to 3
      // sellers" sets a different expectation about replies than "sent",
      // so the buyer is told rather than left to guess.
      setSellers(result.sellerCount);
      setStatus("sent");
      onClear();
      return;
    }
    setStatus("error");
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 p-3 shadow-lg backdrop-blur">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        {status === "sent" ? (
          <div role="status" className="text-sm">
            <p className="font-medium">{t("sentTitle")}</p>
            <p className="text-muted-foreground">
              {t("sentMessage", { sellers })}
            </p>
            {skipped > 0 && (
              <p className="text-muted-foreground">
                {t("sentWithSkipped", { skipped })}
              </p>
            )}
          </div>
        ) : status === "open" || status === "sending" || status === "error" ? (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3"
            aria-label={t("formLabel", { count: productIds.length })}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${formId}-name`} className="text-sm font-medium">
                  {t("name")}
                </label>
                <Input
                  id={`${formId}-name`}
                  name="buyerName"
                  required
                  maxLength={INQUIRY_NAME_MAX_LENGTH}
                  autoComplete="name"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${formId}-phone`} className="text-sm font-medium">
                  {t("phone")}
                </label>
                <Input
                  id={`${formId}-phone`}
                  name="buyerPhone"
                  type="tel"
                  required
                  placeholder="+91 98765 43210"
                  autoComplete="tel"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${formId}-message`} className="text-sm font-medium">
                {t("message")}
              </label>
              <textarea
                id={`${formId}-message`}
                name="message"
                required
                rows={2}
                maxLength={INQUIRY_MESSAGE_MAX_LENGTH}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
              />
            </div>
            {status === "error" && (
              <p role="alert" className="text-sm text-destructive">
                {t("error")}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={status === "sending" || overLimit}
                className="gap-2 bg-[#0F7A3D] text-white hover:bg-[#0C6531] focus-visible:ring-[#25D366]/50"
              >
                <WhatsAppIcon className="size-5" />
                {status === "sending"
                  ? t("sending")
                  : t("submit", { count: productIds.length })}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStatus("idle")}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* aria-live so the count is announced as items are ticked, rather
                than a screen-reader user having to go looking for it. */}
            <p className="text-sm font-medium" aria-live="polite">
              {t("selectedCount", { count: productIds.length })}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={onClear}>
                {t("clear")}
              </Button>
              <Button
                type="button"
                onClick={() => setStatus("open")}
                disabled={overLimit}
                className="gap-2 bg-[#0F7A3D] text-white hover:bg-[#0C6531] focus-visible:ring-[#25D366]/50"
              >
                <WhatsAppIcon className="size-5" />
                {t("ask")}
              </Button>
            </div>
          </div>
        )}

        {overLimit && (
          // Explained at the point of the problem, and the submit disabled, so
          // the cap is discovered before typing a message rather than after.
          <p role="alert" className="text-sm text-destructive">
            {t("tooMany", { max: INQUIRY_BULK_MAX_PRODUCTS })}
          </p>
        )}
      </div>
    </div>
  );
}
