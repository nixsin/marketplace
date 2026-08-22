import { Injectable, Logger } from '@nestjs/common';
import {
  WHATSAPP_ACCESS_TOKEN_ENV,
  WHATSAPP_API_BASE_URL,
  WHATSAPP_API_VERSION,
  WHATSAPP_PHONE_NUMBER_ID_ENV,
  WHATSAPP_REQUEST_TIMEOUT_MS,
  WHATSAPP_TEMPLATE_DEFAULT_LANGUAGE,
  WHATSAPP_TEMPLATE_LANGUAGE_ENV,
  WHATSAPP_TEMPLATE_NAME_ENV,
  WHATSAPP_ALLOW_FREE_FORM_ENV,
  WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH,
} from '@medinstru/config';
// The ONE implementation, re-exported by this module's neighbour. This file
// used to carry its own copy, whose regex required at least eight digits --
// the bug part 1 removed, because Saint Helena (+290 8123) and the Cook
// Islands (+682 1234) are seven digits end to end. A third copy is precisely
// what part 2 consolidated away after two of them drifted.
import { normalizeE164 } from './phone';

export type WhatsappSendResult =
  | { ok: true; providerMessageId: string | null }
  /**
   * AMBIGUOUS: the request may or may not have reached Meta. A timeout or a
   * dropped connection means the message might already be on its way, so
   * this must never be treated as a definite failure -- retrying from that
   * assumption is how a seller receives the same inquiry twice.
   */
  | { ok: false; ambiguous: true; reason: string }
  | { ok: false; ambiguous?: false; reason: string };

/**
 * Makes a value safe to pass as a WhatsApp template parameter.
 *
 * Meta rejects a parameter containing a newline, a tab, or more than four
 * consecutive spaces -- the whole message is refused, not just the parameter.
 * The composed inquiry is deliberately multi-line, so flattening is required
 * rather than cosmetic: without it every production send fails validation.
 */
export function sanitizeTemplateParam(value: string): string {
  return (
    value
      .replace(/[\r\n\t]+/g, ' \u00b7 ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      // TODO(#151): truncate by code point, not UTF-16 code unit.
      //
      // .slice() counts UTF-16 code units, so a cut landing inside a surrogate
      // pair leaves an unpaired surrogate in the outbound parameter. Verified:
      // slicing 'x'.repeat(1023) + an emoji at 1024 does exactly that.
      //
      // FREQUENCY: requires a message that reaches the 1024-character cap AND
      // has a non-BMP character straddling that exact boundary. Inquiry text is
      // capped at 1000 and the summary is bounded well below it, so no current
      // caller can reach the cap at all -- this is reachable only if those
      // limits are raised.
      //
      // FIX WHEN TOUCHED: [...value].slice(0, max).join(''), plus a boundary
      // test containing an emoji.
      .slice(0, WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH)
  );
}

/**
 * Sends product inquiries to a seller's verified WhatsApp Business number via
 * Meta's Cloud API.
 *
 * Follows SmsService's shape deliberately: the real provider call is written
 * out, but it degrades to a logged no-op when credentials are absent, because
 * the Meta Business account, verified number and approved templates are
 * account setup that cannot be done from this repo. That keeps the feature
 * mergeable and testable before the account exists, rather than blocking the
 * whole flow on it.
 *
 * Credentials are read BY NAME at call time (never imported as values, never
 * cached in a field), so a misconfiguration cannot bake a token into a
 * constructed object, and the error text names only the variable.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  /**
   * Sends an inquiry to a seller.
   *
   * TEMPLATE, not free-form text, whenever a template name is configured.
   * WhatsApp only permits free-form text inside a 24-hour customer-service
   * window that the RECIPIENT opens by messaging the business first. This
   * flow is always business-initiated -- the marketplace speaks first, to a
   * seller who has never messaged it -- so a plain text send is rejected by
   * Meta in production even with perfectly valid credentials. The first
   * version of this service sent `type: 'text'` and would have failed every
   * real send while passing every test.
   *
   * The text path remains only for the case where a template is deliberately
   * not configured, which is development and an open reply window.
   */
  async sendInquiry(
    toE164: string,
    parts: { summary: string; buyerMessage: string },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<WhatsappSendResult> {
    const body = `${parts.summary}\n\n${parts.buyerMessage}`;
    // Validated here as well as at the DTO boundary. This is the last point
    // before an outbound request leaves the system, and a malformed number
    // reaching Meta is a rejected send that costs a round trip to learn.
    // NORMALISED, not merely validated -- the asymmetry this had with the
    // buyer's number was a silent bug. A seller whose number is stored as
    // "+91 98765 43210" -- the exact format the buyer form advertises as an
    // example, because that is how people write numbers -- was rejected here
    // AND reported uncontactable by Product.hasInquiryContact, so the form
    // never rendered and no inquiry ever reached them. No error anywhere;
    // they would simply never hear from anyone.
    //
    // Unreachable today because nothing but the seed writes this column, and
    // it writes canonical values. It stops being unreachable the moment
    // seller onboarding ships, which is why it is worth an extra call now.
    const recipient = normalizeE164(toE164);
    if (!recipient) {
      return { ok: false, reason: 'seller number is not valid E.164' };
    }

    const token = env[WHATSAPP_ACCESS_TOKEN_ENV];
    const phoneNumberId = env[WHATSAPP_PHONE_NUMBER_ID_ENV];

    if (!token || !phoneNumberId) {
      // Deliberately loud, and deliberately NOT an exception. The caller has
      // already recorded the inquiry; throwing here would lose a real lead
      // over a configuration gap. Names the variables, never a value.
      this.logger.warn(
        `[NOT CONFIGURED] WhatsApp send skipped: set ${WHATSAPP_ACCESS_TOKEN_ENV} and ` +
          `${WHATSAPP_PHONE_NUMBER_ID_ENV} to deliver inquiries. The inquiry is still recorded.`,
      );
      return {
        ok: false,
        reason: `not configured (${WHATSAPP_ACCESS_TOKEN_ENV}, ${WHATSAPP_PHONE_NUMBER_ID_ENV})`,
      };
    }

    const templateName = env[WHATSAPP_TEMPLATE_NAME_ENV];
    const allowFreeForm = env[WHATSAPP_ALLOW_FREE_FORM_ENV] === 'true';

    if (!templateName && !allowFreeForm) {
      // Refused BEFORE the request, not attempted and failed. This flow is
      // always business-initiated, so Meta rejects free-form text outside a
      // recipient-opened 24-hour window -- sending anyway would mark every
      // inquiry FAILED and leave an operator debugging provider errors for
      // what is a missing environment variable.
      this.logger.warn(
        `[NOT CONFIGURED] WhatsApp send skipped: set ${WHATSAPP_TEMPLATE_NAME_ENV} ` +
          `to an approved template. Business-initiated messages cannot be sent as ` +
          `free-form text; set ${WHATSAPP_ALLOW_FREE_FORM_ENV}=true only for a known ` +
          `open service window. The inquiry is still recorded.`,
      );
      return {
        ok: false,
        reason: `not configured (${WHATSAPP_TEMPLATE_NAME_ENV})`,
      };
    }

    const url = `${WHATSAPP_API_BASE_URL}/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

    const payload = templateName
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'template',
          template: {
            name: templateName,
            language: {
              code:
                env[WHATSAPP_TEMPLATE_LANGUAGE_ENV] ??
                WHATSAPP_TEMPLATE_DEFAULT_LANGUAGE,
            },
            // One body parameter carrying the whole composed inquiry,
            // flattened. The approved template must therefore be a body with
            // a single {{1}} placeholder -- see docs/whatsapp.md. More
            // parameters would mean more ways for the repo and the Meta
            // account to disagree about a template nobody here can see.
            // TWO parameters: {{1}} the product/contact summary, {{2}} the
            // buyer's own words. One combined parameter meant a near-limit
            // question lost its ending to the metadata in front of it --
            // silently, after the API had accepted it as valid.
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: sanitizeTemplateParam(parts.summary) },
                  {
                    type: 'text',
                    text: sanitizeTemplateParam(parts.buyerMessage),
                  },
                ],
              },
            ],
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',
          // Link previews off: the body already carries the canonical URL,
          // and Meta fetching it server-side adds latency to the send for a
          // preview the seller does not need.
          text: { preview_url: false, body },
        };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        // A stalled connection must not hold the buyer's request open. Meta
        // accepting the socket and never answering is exactly what a bare
        // fetch waits on forever, leaving the row PENDING and the form spinning.
        signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Meta returns structured errors; surface the message but never the
        // whole payload, which echoes request content back into logs.
        const detail = await this.readErrorMessage(response);
        const reason = `provider ${response.status}: ${detail}`;

        // A 5xx is AMBIGUOUS, exactly like a timeout.
        //
        // The asymmetry this fixes was stark: our own AbortSignal firing at
        // 10s was treated as "we do not know", while Meta's gateway timing
        // out at 9s and answering 504 was treated as "definitely not sent".
        // Same physical situation, opposite conclusion. A 502/503/504 means
        // the request may well have reached Meta and been processed before
        // the gateway gave up, so recording FAILED tells an operator it
        // definitely did not send -- and a retry from that belief puts the
        // inquiry on the seller's phone twice.
        //
        // 4xx stays definite, including 429: those are Meta rejecting the
        // request outright, which is a real answer rather than an absence of
        // one.
        if (response.status >= 500) {
          return { ok: false, ambiguous: true, reason };
        }
        return { ok: false, reason };
      }

      // Parsed in its OWN try. Meta has accepted the message by this point --
      // response.ok is true -- so a body that will not parse must degrade to
      // "sent, id unknown" rather than reporting failure. Letting it fall to
      // the outer catch marked a delivered inquiry FAILED, and a retry from
      // that state sends the seller a duplicate.
      //
      // Named apart from the request `payload` above: both live in this same
      // block, so reusing the name is a temporal-dead-zone error, not a shadow.
      try {
        const responseBody: unknown = await response.json();

        // Success is a property of the BODY, not the status line.
        //
        // This repo already learned that inbound -- see CLAUDE.md on
        // edge-caching GraphQL, where a resolver failure arrives as HTTP 200
        // with an `errors` array. The same discipline outbound costs nothing
        // and guards the highest-stakes error in this feature: marking an
        // inquiry SENT that was never accepted, which once the buyer is told
        // about delivery becomes a person waiting for a reply that is not
        // coming.
        if (hasErrorKey(responseBody)) {
          return {
            ok: false,
            reason: `provider ${response.status}: error in an otherwise successful response`,
          };
        }

        // A 2xx with no recognisable acceptance is AMBIGUOUS, not success.
        //
        // Meta answers an accepted send with `{ messages: [{ id }] }`. A body
        // without one -- `{}`, or any shape we do not recognise -- proves only
        // that some HTTP intermediary returned 200, which a proxy error page
        // does too. Recording SENT there tells the buyer, once part 4 reports
        // delivery, that a message arrived which may never have been sent.
        //
        // Not FAILED either: Meta may genuinely have accepted it, and FAILED
        // invites a retry that double-messages the seller. PENDING is the
        // honest answer, and it is the same answer a timeout gets.
        const providerMessageId = readMessageId(responseBody);
        if (!providerMessageId) {
          return {
            ok: false,
            ambiguous: true,
            reason: `provider ${response.status} with no recognisable acceptance in the body`,
          };
        }
        return { ok: true, providerMessageId };
      } catch {
        // Same reasoning: an unparseable body cannot confirm anything. This
        // previously recorded SENT with a null id, which is the one outcome
        // that is definitely wrong -- it claims certainty from an absence.
        this.logger.warn(
          'Provider returned a success status with an unparseable body; ' +
            'left ambiguous rather than recorded as sent.',
        );
        return {
          ok: false,
          ambiguous: true,
          reason: 'provider response body did not parse',
        };
      }
    } catch (error) {
      // Network failure, DNS, timeout. The inquiry is already persisted, so
      // this degrades to a FAILED row an operator can retry from, not a lost
      // lead and not a 500 shown to the buyer.
      // AbortSignal.timeout rejects with a TimeoutError; surfaced by name so
      // an operator reading failureReason can tell a stall from a refusal.
      // A timeout or a transport error is AMBIGUOUS, not a failure: the
      // request may have reached Meta and been accepted before the response
      // was lost. Recording it as FAILED invites a retry that double-messages
      // the seller.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const reason = timedOut
        ? `provider timed out after ${WHATSAPP_REQUEST_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : 'unknown send failure';
      return { ok: false, ambiguous: true, reason };
    }
  }

  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const payload: unknown = await response.json();
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload
      ) {
        const { error } = payload as { error?: { message?: unknown } };
        if (typeof error?.message === 'string') return error.message;
      }
    } catch {
      // A non-JSON error body is itself the useful signal; do not let
      // parsing it throw over the top of the original failure.
    }
    return response.statusText || 'unrecognised provider error';
  }
}

/**
 * Meta answers with `{ messages: [{ id }] }`. Read defensively: a shape
 * change must degrade to "sent, id unknown" rather than throwing away a send
 * that actually succeeded.
 */
function readMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { messages } = payload as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first: unknown = messages[0];
  if (typeof first !== 'object' || first === null) return null;
  const { id } = first as { id?: unknown };
  return typeof id === 'string' ? id : null;
}

/**
 * Whether a parsed provider response carries an error, whatever its status.
 *
 * Deliberately shallow and shape-agnostic: the point is not to interpret
 * Meta's error format but to refuse to call something a success when the body
 * says otherwise.
 */
function hasErrorKey(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    (payload as { error?: unknown }).error != null
  );
}
