import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProductNotFound from "./not-found";

// useTranslations, not getTranslations: this boundary is a Client Component
// now. That is not a refactor for its own sake -- a server-side
// getTranslations() here has no locale to work from (not-found.js takes no
// props) so next-intl fell back to headers(), which is precisely what stopped
// the whole route from ever being prerenderable. See not-found.tsx.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
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
  it("says the product is gone and offers a way back", () => {
    const html = renderToStaticMarkup(<ProductNotFound />);

    expect(html).toContain("t:notFoundTitle");
    expect(html).toContain("t:notFoundMessage");
    // The escape hatch, which is the part that matters.
    expect(html).toContain('href="/"');
    expect(html).toContain("t:backToListing");
  });

  it("is LOCALISED, unlike the root not-found", () => {
    // The reason this file exists at all: without it Next falls back to
    // app/not-found.tsx, which is deliberately un-localised and rendered
    // outside the locale providers -- the wrong fallback for "this specific
    // product was removed".
    const html = renderToStaticMarkup(<ProductNotFound />);
    expect(html).not.toContain("<html");
    expect(html).toMatch(/t:[a-zA-Z]/);
  });

  it("renders without any server-side next-intl call", () => {
    // The regression that matters here is not visual. If this component goes
    // back to `await getTranslations(...)`, it renders fine in development
    // and in every test that mocks it -- and silently makes the route
    // dynamic again in production, because next-intl reaches for headers()
    // when it has no locale. Rendering synchronously is the observable
    // difference: a Server Component version returns a promise.
    const rendered = ProductNotFound();
    expect(rendered).not.toBeInstanceOf(Promise);
  });
});
