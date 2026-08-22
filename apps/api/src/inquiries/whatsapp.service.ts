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

/** E.164: a leading + and 8-15 digits, first digit non-zero. */
const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Canonicalises a submitted number to E.164.
 *
 * The form advertised `+91 98765 43210` while the sender rejected anything
 * containing a space, and class-validator's IsPhoneNumber happily accepts the
 * spaced form -- so a perfectly reasonable entry was stored and then failed at
 * the point of sending, which the buyer only learns about by never getting a
 * reply. Normalising here means the format a person naturally types is the
 * format that actually sends.
 *
 * Returns null when the value cannot be made valid, so the caller rejects it
 * at the boundary rather than storing something undeliverable.
 */
export function normalizeE164(value: string): string | null {
  const stripped = value.replace(/[\s\u00a0().-]/g, '');
  return isE164(stripped) ? stripped : null;
}

/**
 * Makes a value safe to pass as a WhatsApp template parameter.
 *
 * Meta rejects a parameter containing a newline, a tab, or more than four
 * consecutive spaces -- the whole message is refused, not just the parameter.
 * The composed inquiry is deliberately multi-line, so flattening is required
 * rather than cosmetic: without it every production send fails validation.
 */
export function sanitizeTemplateParam(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' \u00b7 ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH);
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
   * All THREE are required, template name included.
   *
   * Treating the template as optional meant a deployment with credentials but
   * no template silently sent free-form text Meta rejects for this flow, and
   * marked every inquiry FAILED. A half-configured deployment should say so,
   * not fail one message at a time.
   */
  isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
      env[WHATSAPP_ACCESS_TOKEN_ENV] &&
      env[WHATSAPP_PHONE_NUMBER_ID_ENV] &&
      (env[WHATSAPP_TEMPLATE_NAME_ENV] ||
        env[WHATSAPP_ALLOW_FREE_FORM_ENV] === 'true'),
    );
  }

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
    if (!isE164(toE164)) {
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
          to: toE164,
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
          to: toE164,
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
        return { ok: false, reason: `provider ${response.status}: ${detail}` };
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
        return { ok: true, providerMessageId: readMessageId(responseBody) };
      } catch {
        this.logger.warn(
          'Provider accepted the message but its response body did not parse; ' +
            'recorded as sent without a provider message id.',
        );
        return { ok: true, providerMessageId: null };
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
