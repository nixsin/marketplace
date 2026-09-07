import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProductNotFound from "./not-found";

vi.mock("next-intl/server", () => ({
  getTranslations: () =>
    Promise.resolve((key: string) => `t:${key}`),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

/**
 * The boundary a removed product lands on.
 *
 * Worth testing rather than assuming, for one reason that is not about this
 * markup: it must offer a way OUT. A visitor who followed a shared WhatsApp
 * link to a delisted product otherwise reaches a dead end with no navigation,
 * and this route deliberately does not render the root not-found, which sits
 * outside Header/Footer/LocaleProvider.
 */
describe("product not-found", () => {
  it("says the product is gone and offers a way back", async () => {
    const html = renderToStaticMarkup(await ProductNotFound());

    expect(html).toContain("t:notFoundTitle");
    expect(html).toContain("t:notFoundMessage");
    // The escape hatch, which is the part that matters.
    expect(html).toContain('href="/"');
    expect(html).toContain("t:backToListing");
  });

  it("is LOCALISED, unlike the root not-found", async () => {
    // The reason this file exists at all: without it Next falls back to
    // app/not-found.tsx, which is deliberately un-localised and rendered
    // outside the locale providers -- the wrong fallback for "this specific
    // product was removed".
    const html = renderToStaticMarkup(await ProductNotFound());
    expect(html).not.toContain("<html");
    expect(html).toMatch(/t:[a-zA-Z]/);
  });
});
