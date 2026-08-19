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

describe("productShareUrl cannot be made to point at another origin", () => {
  const origin = new URL(productShareUrl("p1", "en")).origin;

  it.each([
    ["/evil.example"],
    ["//evil.example"],
    ["https://evil.example"],
    ["../../evil"],
    [""],
  ])("stays on our origin for locale %j", (locale) => {
    // `//host` makes the path protocol-relative, so new URL() resolves it
    // against a different host entirely. Verified as a real escape before
    // the fix: "//evil.example" produced https://evil.example/products/p1.
    expect(new URL(productShareUrl("p1", locale)).origin).toBe(origin);
  });

  it("falls back to the default locale rather than emitting a junk path", () => {
    expect(productShareUrl("p1", "//evil.example")).toContain("/en/products/p1");
  });

  it("still honours a genuinely supported locale", () => {
    expect(productShareUrl("p1", "hi")).toContain("/hi/products/p1");
  });
});

describe("productShareUrl prefers a runtime origin", () => {
  it("uses the supplied origin over the build-time SITE_URL", () => {
    // The production bug this exists for: NEXT_PUBLIC_SITE_URL was never set
    // on the deployed service, so every shared link pointed at
    // http://localhost:3000 -- useless to the recipient, and the one thing
    // the whole feature has to get right.
    const url = productShareUrl("p1", "en", "https://real.example");
    expect(url).toBe("https://real.example/en/products/p1");
    expect(url).not.toContain("localhost");
  });

  it("falls back to SITE_URL when no origin is given (server render)", () => {
    expect(productShareUrl("p1", "en")).toContain("/en/products/p1");
  });

  it("is already shareable before hydration, not just after", () => {
    // The server render has no window, so useSyncExternalStore's server
    // snapshot yields undefined and this falls back to SITE_URL. That is
    // the href a tap follows on a slow connection before JS runs, so it
    // must be a real absolute URL rather than a relative or empty one.
    //
    // A review raised that this path could still emit localhost. It cannot
    // on a deployed build: next.config.ts refuses to build when
    // NEXT_PUBLIC_SITE_URL is unset or points at a local address (see
    // src/lib/site-url.ts), so SITE_URL is always a valid public origin
    // there. Locally, localhost is the correct answer.
    const serverRendered = productShareUrl("p1", "en");
    expect(serverRendered).toMatch(/^https?:\/\/[^/]+\/en\/products\/p1$/);
  });

  it("ignores an empty origin rather than producing a relative URL", () => {
    expect(productShareUrl("p1", "en", "")).toMatch(/^https?:\/\//);
  });

  it("still constrains the locale when a runtime origin is used", () => {
    const url = productShareUrl("p1", "//evil.example", "https://real.example");
    expect(new URL(url).origin).toBe("https://real.example");
  });
});
