import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import NotFound from "./not-found";

/**
 * The ROOT not-found, which is a different thing from the product one.
 *
 * It renders its own <html> and <body> because Next uses it outside any
 * layout -- for a path that matched no route at all, where LocaleProvider
 * has not run and there is no locale to translate into. Its plainness is
 * deliberate, so this asserts the structure rather than any copy.
 */
describe("root not-found", () => {
  it("renders a complete document, since no layout wraps it", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain("404");
  });

  it("declares a language, so a screen reader has one", () => {
    // The one accessibility property a document rendered outside every
    // provider still has to carry itself.
    expect(renderToStaticMarkup(<NotFound />)).toContain('lang="en"');
  });
});
