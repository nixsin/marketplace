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
  // ONE rule: every run of whitespace becomes a single space.
  //
  // This replaces two rules that between them left a hole. An explicit class
  // handled \r \n \t U+2028 U+2029, and a separate `\s{2,}` collapsed runs --
  // so a LONE U+000B vertical tab, U+000C form feed, non-breaking space or
  // BOM matched neither and survived into the outbound parameter. It went
  // unnoticed through a QA pass here because the probe fed two such
  // characters ADJACENTLY, which hits the run collapse and looks clean; a
  // single one does not.
  //
  // `\s` covers every case the explicit class listed, plus the vertical
  // whitespace it missed, plus U+00A0 and U+FEFF. `+` rather than `{2,}` so a
  // single occurrence is normalised too.
  //
  // It can only CONTRACT, which is the property the parameter budget depends
  // on: the DTO permits 1000 characters against Meta's 1024, and an earlier
  // separator that replaced one character with three quietly broke that --
  // a fourteen-line spec list lost its ending, silently, after Meta had
  // accepted the message as valid.
  // U+0085 NEXT LINE is added explicitly: it is a C1 control that terminates
  // a line in several encodings, and JS `\s` does NOT match it -- verified,
  // not assumed. Everything else vertical is already covered by `\s`.
  const flat = value.replace(/[\s\u0085]+/g, ' ').trim();

  // Truncated by CODE POINT, not UTF-16 code unit: a cut landing inside a
  // surrogate pair would leave an unpaired half in an outbound parameter.
  return truncateByCodePoint(flat, WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH);
}

/**
 * Truncates without splitting a surrogate pair.
 *
 * String.slice counts UTF-16 code units, so a cut landing between the halves
 * of a non-BMP character -- an emoji, most CJK extensions -- leaves an
 * unpaired surrogate in the outbound value. Spreading iterates by code point,
 * so a cut can only land between whole characters.
 */
export function truncateByCodePoint(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join('');
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
    // The leading + is KEPT, deliberately, and this is not a detail to
    // "clean up". Meta's own send-messages guide: "We highly recommend that
    // you include both the plus sign and country calling code when sending a
    // message to a customer. If the plus sign is omitted, your business phone
    // number's country calling code is prepended to the customer's phone
    // number." Their canonical example sends `"to": "+16505551234"`.
    //
    // So stripping it would not be cosmetic -- it would risk misdelivery for
    // every buyer whose country differs from the business number's, which for
    // an India-and-US marketplace is a large fraction of them. Raised once as
    // a High-severity finding claiming the opposite; checked against the
    // documentation rather than acted on.
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
            // TWO parameters: {{1}} the product/contact summary, {{2}} the
            // buyer's own words. The approved template must therefore have a
            // body with both placeholders -- see docs/whatsapp.md for the
            // exact contract.
            //
            // One combined parameter meant a near-limit question lost its
            // ending to the metadata sitting in front of it -- silently,
            // after the API had already accepted the message as valid.
            // Separate parameters give the buyer's words their own budget.
            //
            // (An earlier version of this comment still described the
            // one-parameter design the code had already stopped using, which
            // is worse than no comment: the template lives in the Meta
            // account, where nobody reading this file can check it.)
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
