import { describe, expect, it } from "vitest";
import { sitemapIndexXml, urlSetXml } from "./sitemap-xml";

describe("sitemap XML", () => {
  it("escapes dynamic values in indexes", () => {
    expect(sitemapIndexXml(["https://example.com/sitemap?x=1&y=2"])).toContain(
      "https://example.com/sitemap?x=1&amp;y=2",
    );
  });

  it("serializes URL metadata and locale alternates", () => {
    const xml = urlSetXml([
      {
        url: "https://example.com/en/products/p1",
        lastModified: "2026-08-20T00:00:00.000Z",
        changeFrequency: "weekly",
        priority: 0.8,
        alternates: { hi: "https://example.com/hi/products/p1" },
      },
    ]);
    expect(xml).toContain("<lastmod>2026-08-20T00:00:00.000Z</lastmod>");
    expect(xml).toContain('hreflang="hi"');
  });
});
