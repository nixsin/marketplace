import { isE164, normalizeE164 } from '@medinstru/config';

/**
 * Phone-number validation and canonicalisation for inquiries.
 *
 * The IMPLEMENTATION lives in @medinstru/config, not here, because apps/web
 * needs the identical function and a second copy drifts silently -- which it
 * did. The server stores and compares the canonical form, so an idempotency
 * key is bound to that value; the web client decides whether a retry is the
 * same submission. With the two sides normalising differently, reformatting
 * "+919000000001" as "+91 90000 00001" read as an edit on the client and as
 * the same submission on the server, producing a duplicate inquiry.
 *
 * Re-exported rather than imported directly at each call site so this module
 * stays the place you land when you go looking for "how does this project
 * handle phone numbers", and so nothing here had to change when the
 * implementation moved.
 *
 * This started inside the WhatsApp client, which coupled anything needing to
 * validate a number to the whole delivery layer -- Product.hasInquiryContact
 * had to import the Cloud API service just to ask "is this number usable".
 * Nothing in this path knows a provider exists.
 */
export { isE164, normalizeE164 };
