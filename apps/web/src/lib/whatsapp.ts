import { SITE_URL } from "@medinstru/config";

// WhatsApp share-link construction, kept as pure functions so the message
// format and URL encoding are directly testable -- the whole point of this
// feature is what the recipient sees, and that is entirely determined by
// these two strings.
//
// Scope note (issue #91): this is the SHARE half only -- buyer to whoever
// they choose. The INQUIRY half (buyer to seller) is deliberately absent:
// it needs a seller contact number, and both the schema field and the
// decision about whose number it should be (personal / branch /
// marketplace-managed) are still open. Publishing a seller's personal
// number is exactly the privacy risk #91 flags, so guessing here would be
// the wrong kind of progress.

/**
 * A product's canonical, shareable URL. Absolute by construction: a
 * WhatsApp message is read on someone else's device, so a relative path is
 * useless -- the recipient has no origin to resolve it against.
 */
export function productShareUrl(productId: string, locale: string): string {
  // `new URL(path, base)` rather than string concatenation so a trailing
  // slash on SITE_URL can't produce a double slash.
  return new URL(`/${locale}/products/${encodeURIComponent(productId)}`, SITE_URL).toString();
}

/**
 * The message body pre-filled into WhatsApp.
 *
 * Deliberately name + URL and nothing else. WhatsApp renders a link preview
 * card from the page's OpenGraph tags, so repeating the description here
 * would duplicate what the card already shows while pushing the link itself
 * further down the message. The product name carries the context if preview
 * generation fails or is disabled.
 */
export function productShareMessage(productName: string, url: string): string {
  return `${productName}\n${url}`;
}

/**
 * A wa.me link that opens WhatsApp with the message pre-filled and lets the
 * sender pick any recipient.
 *
 * No phone number in the path, deliberately -- `wa.me/?text=` opens the
 * contact picker, which is the correct behaviour for sharing. `wa.me/<number>`
 * would target a specific recipient and is what the inquiry flow will need
 * once a seller contact field exists.
 */
export function whatsappShareHref(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
