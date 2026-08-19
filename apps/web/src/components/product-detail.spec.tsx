// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductDetailView, type ProductDetail } from "./product-detail";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";

const fullProduct: ProductDetail = {
  id: "1",
  name: "Portable Ultrasound Scanner — US-Pro 7",
  brand: "MedTech Systems",
  category: "Diagnostic Imaging",
  deviceClass: "B",
  certifications: ["ISO 13485", "CE Marked"],
  location: "Chennai, TN",
  description: "A handheld point-of-care ultrasound system.",
  imageUrl: "https://example.com/ultrasound.jpg",
  details: { probeType: "Convex", displaySize: "7in" },
  updatedAt: "2026-08-18T23:37:48.872Z",
  seller: {
    name: "MedTech Systems Pvt Ltd",
    gstin: "33AAACM1234A1Z5",
    kycStatus: "APPROVED",
  },
};

const minimalProduct: ProductDetail = {
  id: "2",
  name: "Surgical Forceps Set",
  brand: "SteelCraft",
  category: "Surgical",
  certifications: [],
  location: "Pune, India",
  description: "Stainless steel, autoclavable forceps set.",
  updatedAt: "2026-08-18T23:37:48.872Z",
  seller: {
    name: "SteelCraft Direct",
    kycStatus: "PENDING",
  },
  // deviceClass, imageUrl, details, seller.gstin intentionally omitted
};

function renderDetail(product: ProductDetail) {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <ProductDetailView product={product} />
    </LocaleProvider>,
  );
}

describe("ProductDetailView", () => {
  it("renders brand/location and description for a fully populated product", () => {
    // The product name itself is deliberately rendered by page.tsx's own
    // <h1>, not by this component -- see product-detail.tsx's own
    // comment on why the "use client" split doesn't include the heading.
    renderDetail(fullProduct);
    expect(
      screen.getByText("MedTech Systems · Chennai, TN"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("A handheld point-of-care ultrasound system."),
    ).toBeInTheDocument();
  });

  it("renders the translated device-class badge when present", () => {
    renderDetail(fullProduct);
    expect(screen.getByText("Class B")).toBeInTheDocument();
  });

  it("does not render a device-class badge when absent", () => {
    renderDetail(minimalProduct);
    expect(screen.queryByText(/^Class /)).not.toBeInTheDocument();
  });

  it("renders the image block when imageUrl is present", () => {
    const { container } = renderDetail(fullProduct);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("does not render the image block when imageUrl is absent", () => {
    const { container } = renderDetail(minimalProduct);
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders one badge per certification", () => {
    renderDetail(fullProduct);
    expect(screen.getByText("ISO 13485")).toBeInTheDocument();
    expect(screen.getByText("CE Marked")).toBeInTheDocument();
  });

  it("renders no certification badges and doesn't throw for an empty certifications array", () => {
    expect(() => renderDetail(minimalProduct)).not.toThrow();
    expect(screen.queryByText("ISO 13485")).not.toBeInTheDocument();
  });

  it("renders category-specific detail fields as key/value pairs when present", () => {
    renderDetail(fullProduct);
    expect(screen.getByText("probeType")).toBeInTheDocument();
    expect(screen.getByText("Convex")).toBeInTheDocument();
    expect(screen.getByText("displaySize")).toBeInTheDocument();
    expect(screen.getByText("7in")).toBeInTheDocument();
  });

  it("renders a 'no specifications' message when details is absent", () => {
    renderDetail(minimalProduct);
    expect(
      screen.getByText("No additional specifications listed."),
    ).toBeInTheDocument();
  });

  it("renders seller name and GSTIN when present", () => {
    renderDetail(fullProduct);
    expect(screen.getByText("MedTech Systems Pvt Ltd")).toBeInTheDocument();
    expect(screen.getByText("GSTIN: 33AAACM1234A1Z5")).toBeInTheDocument();
  });

  it("does not render a GSTIN line when absent", () => {
    renderDetail(minimalProduct);
    expect(screen.queryByText(/^GSTIN:/)).not.toBeInTheDocument();
  });

  it("renders the seller KYC status label", () => {
    renderDetail(fullProduct);
    expect(screen.getByText("Seller KYC status: APPROVED")).toBeInTheDocument();
  });

  it("renders a different KYC status label for a pending seller", () => {
    renderDetail(minimalProduct);
    expect(screen.getByText("Seller KYC status: PENDING")).toBeInTheDocument();
  });

  it("renders the last-updated date, localized", () => {
    renderDetail(fullProduct);
    // Intl.DateTimeFormat("en", { dateStyle: "medium" }) on the fixture's
    // updatedAt -- exact wording asserted rather than a loose regex, since
    // this is deterministic given a fixed locale + fixed input date.
    expect(screen.getByText(/Last updated Aug 18, 2026/)).toBeInTheDocument();
  });

  it("renders the same last-updated date regardless of the machine's local timezone", () => {
    // Regression test for a real hydration-mismatch bug (PR #94 review):
    // the fixture's updatedAt (23:37:48 UTC) falls on a different calendar
    // date in IST (Aug 19) than in UTC (Aug 18). Before pinning
    // `timeZone: "UTC"` in product-detail.tsx, this component's output
    // depended on the *runtime's* local timezone -- meaning a server
    // rendering in UTC and a browser hydrating in IST would produce
    // different text and React would throw a hydration mismatch. Setting
    // process.env.TZ to a UTC+5:30 zone here reproduces exactly that
    // divergent-runtime scenario locally; asserting it still reads "Aug 18"
    // proves the fix, not just that the happy path still renders.
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      renderDetail(fullProduct);
      expect(screen.getByText(/Last updated Aug 18, 2026/)).toBeInTheDocument();
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("renders a nested object detail value as readable JSON, not '[object Object]'", () => {
    // Regression test for a real bug (PR #94 review): `details` is
    // unconstrained JSON, so a value can be a nested object/array, not
    // just a primitive. String(value) on those silently produced the
    // literal text "[object Object]".
    renderDetail({
      ...fullProduct,
      details: { warranty: { years: 2, region: "IN" } },
    });
    expect(screen.getByText('{"years":2,"region":"IN"}')).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });
});
