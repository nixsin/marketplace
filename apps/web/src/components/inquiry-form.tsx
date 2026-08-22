"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  INQUIRY_MESSAGE_MAX_LENGTH,
  INQUIRY_NAME_MAX_LENGTH,
} from "@medinstru/config";
import { submitInquiry, type InquiryFailure } from "@/lib/api";
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
  const [delivered, setDelivered] = useState(false);
  // One key per SUBMISSION, held across retries.
  //
  // Regenerating it per attempt would defeat the server's deduplication
  // entirely -- a lost response is indistinguishable from a failure, so the
  // retry that follows must carry the same key or it becomes a second
  // inquiry and a second WhatsApp message to the seller.
  const submissionKey = useRef<string>(crypto.randomUUID());
  const [error, setError] = useState<InquiryFailure | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setStatus("sending");
    setError(null);

    const result = await submitInquiry({
      idempotencyKey: submissionKey.current,
      productId,
      buyerName: String(data.get("buyerName") ?? "").trim(),
      buyerPhone: String(data.get("buyerPhone") ?? "").trim(),
      message: String(data.get("message") ?? "").trim(),
    });

    if (result.ok) {
      // The confirmation is BRANCHED on delivery, not fixed.
      //
      // Two earlier versions claimed more than the API knew -- first "the
      // seller has your question and your number", then "passed it to this
      // seller" -- and both were shown verbatim when delivery had failed.
      // A buyer told their message reached a seller who never received it
      // waits for a reply that cannot come, and does not retry.
      setDelivered(result.delivered);
      setStatus("sent");
      return;
    }
    setStatus("error");
    setError(result.reason);
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
        <p className="mt-1 text-muted-foreground">
          {delivered ? t("inquirySentDelivered") : t("inquirySentRecorded")}
        </p>
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
          {/* Specific to what actually went wrong. One fixed "check your
              phone number" was wrong for a network error and actively
              misleading for a rate limit, where retrying cannot succeed. */}
          {t(`inquiryError.${error ?? "unknown"}`)}
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
