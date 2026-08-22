"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  INQUIRY_MESSAGE_MAX_LENGTH,
  INQUIRY_NAME_MAX_LENGTH,
  normalizeE164,
} from "@medinstru/config";
import { submitInquiry, type InquiryFailure } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";

type Status = "idle" | "sending" | "sent" | "error";

/**
 * Buyer-to-seller inquiry (#91).
 *
 * Distinct from the share button above it, and the distinction is the point:
 * share opens WhatsApp's contact picker so the BUYER forwards a listing to
 * whoever they choose, while this records a question FOR the seller.
 *
 * The lead is captured; delivering it is a separate change. The confirmation
 * says only that, because saying more would be false.
 *
 * The seller's number is never sent to the browser -- delivery happens
 * server-side when it exists -- so a scraper cannot harvest seller numbers by
 * loading product pages. #91 story 6 is explicit that sellers must not have
 * staff exposed to unsolicited contact.
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
  // One key per SUBMISSION -- held across retries of the SAME content, and
  // minted afresh the moment that content changes.
  //
  // Both halves are load-bearing. Regenerating per attempt would defeat the
  // server's deduplication entirely: a lost response is indistinguishable
  // from a failure, so the retry that follows must carry the same key or it
  // becomes a second inquiry, and a second message to the seller once
  // delivery exists.
  //
  // Holding it across an EDIT is the opposite failure, and it was reproduced
  // against a real server: the buyer retries after fixing their phone number
  // and rewording the question, the server matches the key, returns the
  // original row, and the confirmation reports the edited inquiry as
  // recorded. It never was -- the correction is gone and nothing says so.
  // The server now rejects that mismatch rather than swallowing it; this
  // keeps a buyer from ever meeting the rejection, because an edit really is
  // a new submission.
  const submissionKey = useRef<string>(crypto.randomUUID());
  const lastSubmitted = useRef<string | null>(null);
  const [error, setError] = useState<InquiryFailure | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setStatus("sending");
    setError(null);

    const submission = {
      productId,
      buyerName: String(data.get("buyerName") ?? "").trim(),
      buyerPhone: String(data.get("buyerPhone") ?? "").trim(),
      message: String(data.get("message") ?? "").trim(),
    };

    // Compared against what was last SENT, not against the previous render.
    // The fields are uncontrolled, so there is no state to diff -- and this
    // is the value the server actually stored under the current key, which
    // is the thing the key has to keep matching.
    //
    // The phone is CANONICALISED first, using the server's own function.
    // Comparing the raw string made a formatting-only edit look like a
    // different submission: retype "+919000000001" as "+91 90000 00001" while
    // retrying and this minted a fresh key, so the server -- which stores and
    // compares the canonical form -- saw a new submission and wrote a SECOND
    // inquiry, and would send a second message once delivery ships. Falls
    // back to the raw value when it cannot be canonicalised, so an
    // unsubmittable number still fingerprints deterministically.
    const fingerprint = JSON.stringify({
      ...submission,
      buyerPhone: normalizeE164(submission.buyerPhone) ?? submission.buyerPhone,
    });
    if (lastSubmitted.current !== null && lastSubmitted.current !== fingerprint) {
      submissionKey.current = crypto.randomUUID();
    }
    lastSubmitted.current = fingerprint;

    // Wrapped, so NOTHING can strand the form mid-send.
    //
    // submitInquiry returns a discriminated result rather than throwing, but
    // "does not throw" is a property of its current code, not a guarantee the
    // form can rely on -- one unhandled shape off the wire and the promise
    // rejects instead. Before the fieldset that only froze the submit button;
    // now it would freeze every control, with no way back except a reload.
    // The catch costs nothing and removes the whole class.
    let result: Awaited<ReturnType<typeof submitInquiry>>;
    try {
      result = await submitInquiry({
        idempotencyKey: submissionKey.current,
        ...submission,
      });
    } catch {
      setStatus("error");
      setError("unknown");
      return;
    }

    if (result.ok) {
      // "Recorded", and nothing more, because nothing more has happened.
      //
      // Delivery does not exist yet, so any wording implying the seller has
      // the message would be false. Earlier drafts of this feature claimed
      // exactly that -- "the seller has your question", then "passed it to
      // this seller" -- while delivery had failed, and a buyer told their
      // message arrived waits for a reply that cannot come.
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
          {t("inquirySentRecorded")}
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
            before they type them, not after.

            Says "recorded for this seller", present tense and accurate: the
            details ARE collected so this seller can reply, and nothing has
            been passed to anyone yet. The earlier wording -- "are shared
            with this seller" -- claimed a transfer that has not happened,
            which is the same defect as the confirmation copy this component
            was rewritten around, moved one step earlier in the flow to the
            point where the buyer decides whether to type anything at all.
            Under-disclosing would be its own problem: the purpose of
            collection is to pass these details to the seller, and that is
            what the buyer is agreeing to. */}
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("inquiryRecipientNote")}
        </p>
      </div>

      {/* A fieldset, so EVERY control is disabled while a request is in
          flight -- not just the submit button, which was the case before.
          A buyer could edit the message while waiting and then be shown
          "recorded" for the values that had already been sent: the same
          confirming-something-that-did-not-happen defect this component is
          built around, arriving through the one door still left open.

          A fieldset rather than a `disabled` prop on each input, because
          the next field added would silently miss it. `min-w-0` because a
          fieldset establishes a min-content floor that stops flex children
          shrinking. */}
      <fieldset
        disabled={status === "sending"}
        className="flex min-w-0 flex-col gap-3"
      >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-name`} className="text-sm font-medium">
          {t("inquiryName")}
        </label>
        <Input
          id={`${formId}-name`}
          name="buyerName"
          required
          // Mirrors the DTO's @Length(2). Without it a one-character name
          // reached the server, whose class-validator message
          // ("buyerName must be longer than or equal to 2 characters")
          // matches no branch in categorizeInquiryError -- so the buyer was
          // shown "Something went wrong" for something they could have fixed
          // in a second. Caught at the input, not by pattern-matching server
          // text, because the browser can say which field is wrong.
          minLength={2}
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

      </fieldset>

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
