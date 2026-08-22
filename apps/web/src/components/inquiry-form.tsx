"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import {
  INQUIRY_MESSAGE_MAX_LENGTH,
  INQUIRY_NAME_MAX_LENGTH,
} from "@medinstru/config";
import { submitInquiry } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";

type Status = "idle" | "sending" | "sent" | "error";

/**
 * Buyer-to-seller inquiry, delivered over WhatsApp (#91).
 *
 * Distinct from the share button above it, and the distinction is the point:
 * share opens WhatsApp's contact picker so the BUYER forwards a listing to
 * whoever they choose, while this sends a message to the SELLER. Two
 * different jobs that both happen to use WhatsApp.
 *
 * Deliberately not a `wa.me` link. The seller's number is never sent to the
 * browser -- the send happens server-side -- so a scraper cannot harvest
 * seller numbers by loading product pages. #91 story 6 is explicit that
 * sellers must not have staff exposed to unsolicited contact.
 *
 * No login required (#91 story 3): a WhatsApp-shared link has to work on a
 * cold visit, and putting an account between a buyer and their question is
 * exactly the friction that sends them to a competitor's phone number.
 */
export function InquiryForm({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const t = useTranslations("productDetails");
  const formId = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setStatus("sending");
    setError(null);

    const result = await submitInquiry({
      productId,
      buyerName: String(data.get("buyerName") ?? "").trim(),
      buyerPhone: String(data.get("buyerPhone") ?? "").trim(),
      message: String(data.get("message") ?? "").trim(),
    });

    if (result.ok) {
      // Deliberately "received", not "delivered". The buyer is told the truth
      // about what we know: their inquiry is recorded. Whether the provider
      // accepted it is a seller-side concern they cannot act on, and telling
      // them delivery failed would invite them to resend into the same wall.
      setStatus("sent");
      return;
    }
    setStatus("error");
    setError(result.message);
  }

  if (status === "sent") {
    return (
      <div
        // Announced rather than silently swapped in: a screen-reader user who
        // just submitted needs to know the form was replaced by a result.
        role="status"
        className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
      >
        <p className="font-medium text-foreground">{t("inquirySentTitle")}</p>
        <p className="mt-1 text-muted-foreground">{t("inquirySentMessage")}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-label={t("inquiryAbout", { productName })}
    >
      <div>
        <p className="font-medium text-foreground">{t("inquiryTitle")}</p>
        {/* #91 story 5: the buyer should know who receives their details
            before they type them, not after. */}
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("inquiryRecipientNote")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-name`} className="text-sm font-medium">
          {t("inquiryName")}
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
          {t("inquiryPhone")}
        </label>
        <Input
          id={`${formId}-phone`}
          name="buyerPhone"
          type="tel"
          required
          // The API requires E.164, so say so here rather than letting the
          // server reject a perfectly reasonable-looking local number.
          placeholder="+91 98765 43210"
          autoComplete="tel"
          aria-describedby={`${formId}-phone-hint`}
        />
        <p id={`${formId}-phone-hint`} className="text-xs text-muted-foreground">
          {t("inquiryPhoneHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-message`} className="text-sm font-medium">
          {t("inquiryMessage")}
        </label>
        <textarea
          id={`${formId}-message`}
          name="message"
          required
          rows={4}
          maxLength={INQUIRY_MESSAGE_MAX_LENGTH}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
        />
      </div>

      {error && (
        // role="alert" so the failure is announced; a silently-appearing red
        // line below a button is invisible to a screen reader.
        <p role="alert" className="text-sm text-destructive">
          {t("inquiryError")}
        </p>
      )}

      <Button
        type="submit"
        disabled={status === "sending"}
        className="gap-2 bg-[#0F7A3D] text-white hover:bg-[#0C6531] focus-visible:ring-[#25D366]/50"
      >
        <WhatsAppIcon className="size-5" />
        {status === "sending" ? t("inquirySending") : t("inquirySubmit")}
      </Button>

      {/* #91 story 10: asking one question must not become marketing consent. */}
      <p className="text-xs text-muted-foreground">{t("inquiryPrivacyNote")}</p>
    </form>
  );
}
