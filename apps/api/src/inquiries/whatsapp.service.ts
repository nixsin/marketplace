import { Injectable, Logger } from '@nestjs/common';
import {
  WHATSAPP_ACCESS_TOKEN_ENV,
  WHATSAPP_API_BASE_URL,
  WHATSAPP_API_VERSION,
  WHATSAPP_PHONE_NUMBER_ID_ENV,
} from '@medinstru/config';

export type WhatsappSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; reason: string };

/** E.164: a leading + and 8-15 digits, first digit non-zero. */
const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
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

  isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
      env[WHATSAPP_ACCESS_TOKEN_ENV] && env[WHATSAPP_PHONE_NUMBER_ID_ENV],
    );
  }

  async sendText(
    toE164: string,
    body: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<WhatsappSendResult> {
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

    const url = `${WHATSAPP_API_BASE_URL}/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toE164,
          type: 'text',
          // Link previews off: the body already carries the canonical URL,
          // and Meta fetching it server-side adds latency to the send for a
          // preview the seller does not need.
          text: { preview_url: false, body },
        }),
      });

      if (!response.ok) {
        // Meta returns structured errors; surface the message but never the
        // whole payload, which echoes request content back into logs.
        const detail = await this.readErrorMessage(response);
        return { ok: false, reason: `provider ${response.status}: ${detail}` };
      }

      const payload: unknown = await response.json();
      return { ok: true, providerMessageId: readMessageId(payload) };
    } catch (error) {
      // Network failure, DNS, timeout. The inquiry is already persisted, so
      // this degrades to a FAILED row an operator can retry from, not a lost
      // lead and not a 500 shown to the buyer.
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'unknown send failure',
      };
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
