import type { SVGProps } from "react";

/**
 * The WhatsApp glyph.
 *
 * Inline rather than from an icon package: lucide-react (this repo's icon
 * library) deliberately ships no brand logos, and pulling in a whole
 * brand-icon dependency for a single glyph would cost bundle bytes the
 * JS budget genuinely cannot spare -- see test/bundle-budget.spec.ts's
 * raise history, where the margin has repeatedly been measured in
 * hundreds of bytes.
 *
 * Trademark note: WhatsApp's mark is used here solely to identify the
 * destination of a share action, which is what WhatsApp's own brand
 * guidance permits for share buttons. It is not used as branding for this
 * site, and the button's visible text still reads "Share on WhatsApp"
 * rather than relying on the mark alone.
 *
 * `fill="currentColor"` so the caller decides the colour -- the official
 * green is applied at the call site, but a monochrome rendering (which the
 * brand guidance also permits) stays possible without touching this file.
 */
export function WhatsAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.247-.694.247-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 0 1 6.988 2.896 9.83 9.83 0 0 1 2.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885m8.413-18.297A11.82 11.82 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.548 4.142 1.588 5.945L.057 24l6.305-1.654a11.9 11.9 0 0 0 5.688 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.82 11.82 0 0 0 20.464 3.49" />
    </svg>
  );
}
