import { describe, expect, it } from "vitest";
import { productShareMessage, productShareUrl, whatsappShareHref } from "./whatsapp";

describe("productShareUrl", () => {
  it("is absolute, because the recipient has no origin to resolve against", () => {
    const url = productShareUrl("abc123", "en");
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain("/en/products/abc123");
  });

  it("keeps the locale the sharer was viewing", () => {
    expect(productShareUrl("abc123", "hi")).toContain("/hi/products/");
  });

  it("encodes ids that would otherwise break the path", () => {
    // cuid()s are alphanumeric today, but a future slug-based id could
    // contain characters that need escaping -- and a malformed share link
    // is invisible until someone actually taps it.
    expect(productShareUrl("a b/c?d", "en")).not.toContain(" ");
    expect(productShareUrl("a b/c?d", "en")).toContain("a%20b%2Fc%3Fd");
  });
});

describe("productShareMessage", () => {
  it("is the product name then the URL, nothing more", () => {
    // WhatsApp builds a preview card from the page's OpenGraph tags, so
    // repeating the description here would duplicate the card and push the
    // link further down the message.
    expect(productShareMessage("Ultrasound Scanner", "https://x.test/en/products/1")).toBe(
      "Ultrasound Scanner\nhttps://x.test/en/products/1",
    );
  });
});

describe("whatsappShareHref", () => {
  it("omits a phone number so WhatsApp opens the contact picker", () => {
    // wa.me/<number> would target one recipient; sharing must let the
    // sender choose. The inquiry flow will need the other form.
    const href = whatsappShareHref("hello");
    expect(href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(href).not.toMatch(/wa\.me\/\d/);
  });

  it("percent-encodes newlines and reserved characters", () => {
    const href = whatsappShareHref("A & B\nhttps://x.test/?a=1&b=2");
    expect(href).toContain("%0A");
    expect(href).toContain("%26");
    expect(href).not.toContain("\n");
  });

  it("round-trips back to the original message", () => {
    const message = productShareMessage("Ünïcode — Scanner ✓", "https://x.test/en/products/1");
    const encoded = whatsappShareHref(message).replace("https://wa.me/?text=", "");
    expect(decodeURIComponent(encoded)).toBe(message);
  });
});
