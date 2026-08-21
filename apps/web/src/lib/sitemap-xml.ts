export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function sitemapIndexXml(urls: string[]): string {
  const entries = urls
    .map((url) => `<sitemap><loc>${escapeXml(url)}</loc></sitemap>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

export interface SitemapUrl {
  url: string;
  lastModified?: string;
  changeFrequency?: "daily" | "weekly";
  priority?: number;
  alternates?: Record<string, string>;
}

export function urlSetXml(entries: SitemapUrl[]): string {
  const urls = entries
    .map((entry) => {
      const alternates = Object.entries(entry.alternates ?? {})
        .map(
          ([locale, url]) =>
            `<xhtml:link rel="alternate" hreflang="${escapeXml(locale)}" href="${escapeXml(url)}"/>`,
        )
        .join("");
      return [
        "<url>",
        `<loc>${escapeXml(entry.url)}</loc>`,
        entry.lastModified
          ? `<lastmod>${escapeXml(entry.lastModified)}</lastmod>`
          : "",
        entry.changeFrequency
          ? `<changefreq>${entry.changeFrequency}</changefreq>`
          : "",
        entry.priority === undefined
          ? ""
          : `<priority>${entry.priority}</priority>`,
        alternates,
        "</url>",
      ].join("");
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;
}

export function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
