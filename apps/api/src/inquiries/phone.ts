import { WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH } from '@medinstru/config';

/** E.164: a leading + and 8-15 digits, first digit non-zero. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Phone-number helpers, deliberately in their own module.
 *
 * They started inside the WhatsApp client, which coupled anything needing to
 * validate a number to the whole delivery layer -- `Product.canReceiveInquiries`
 * had to import the Cloud API service just to ask "is this number usable".
 * Nothing here knows about a provider.
 */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Canonicalises a submitted number to E.164.
 *
 * A form advertising `+91 98765 43210` while the sender rejects spaces means a
 * perfectly reasonable entry is stored and then fails at delivery, which the
 * buyer only learns about by never getting a reply. Normalising here means the
 * format a person naturally types is the format that actually sends.
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
 * consecutive spaces -- and rejects the whole message with it, not just the
 * parameter. Any composed message is multi-line by nature, so flattening is
 * required rather than cosmetic.
 */
export function sanitizeTemplateParam(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' \u00b7 ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH);
}
