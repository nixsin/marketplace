// Root-level fallback — deliberately has no i18n dependency. The
// auto-generated /_not-found route sits outside app/[locale]/, so it has
// no LocaleProvider/NextIntlClientProvider context to read from; anything
// using useTranslations() here would throw at build time.
export default function NotFound() {
  return (
    <html lang="en">
      <body>
        <div style={{ padding: "4rem", textAlign: "center" }}>
          <h1>404 — Not found</h1>
        </div>
      </body>
    </html>
  );
}
