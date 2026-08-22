/**
 * E.164: a leading +, a non-zero first digit, and at most 15 digits total.
 *
 * There is no eight-digit MINIMUM, which an earlier version imposed. That
 * rejected real assignments -- Saint Helena (+290 8123) and the Cook Islands
 * (+682 1234) are seven digits end to end -- and because
 * Product.hasInquiryContact calls this directly, those sellers would have
 * silently appeared to have no contact number at all.
 *
 * Being permissive here is the right side to err on: a number that is
 * structurally valid but undeliverable fails at the provider, where the lead
 * is still recorded and an operator can see why. A number wrongly rejected
 * here fails invisibly, by making a real seller look uncontactable.
 */
const E164 = /^\+[1-9]\d{1,14}$/;

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

/**
 * Canonicalises a submitted number to E.164.
 *
 * The form advertises "+91 98765 43210" because that is how people write
 * numbers, and class-validator's IsPhoneNumber accepts that form -- while
 * anything downstream comparing or sending needs the canonical one. Without
 * normalising, the same number written three ways is three different values:
 * three rate-limit buckets, and a stored number that fails at delivery.
 *
 * Returns null when the value cannot be made valid, so the caller rejects it
 * at the boundary rather than storing something undeliverable.
 */
export function normalizeE164(value: string): string | null {
  const stripped = value.replace(/[\s\u00a0().-]/g, '');
  return isE164(stripped) ? stripped : null;
}
