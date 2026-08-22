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
