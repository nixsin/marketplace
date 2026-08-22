/** E.164: a leading + and 8-15 digits, first digit non-zero. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Phone-number validation, deliberately in its own module.
 *
 * This started inside the WhatsApp client, which coupled anything needing to
 * validate a number to the whole delivery layer -- `Product.hasInquiryContact`
 * had to import the Cloud API service just to ask "is this number usable".
 * Nothing here knows a provider exists.
 *
 * Normalisation and template-parameter escaping live with the code that uses
 * them, in the submission and delivery changes respectively, rather than being
 * parked here ahead of a caller.
 */
export function isE164(value: string): boolean {
  return E164.test(value);
}
