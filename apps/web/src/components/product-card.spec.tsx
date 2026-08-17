// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductCard, type Product } from "./product-card";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";

const fullProduct: Product = {
  id: "1",
  name: "Digital Blood Pressure Monitor",
  brand: "MedTech",
  category: "Diagnostics",
  deviceClass: "B",
  certifications: ["CE", "ISO 13485"],
  description: "Automatic, cuff-based, clinical grade accuracy.",
  imageUrl: "https://example.com/bp-monitor.jpg",
  seller: "Acme Medical Supplies",
  location: "Mumbai, India",
};

const minimalProduct: Product = {
  id: "2",
  name: "Surgical Forceps Set",
  brand: "SteelCraft",
  category: "Surgical",
  certifications: [],
  description: "Stainless steel, autoclavable forceps set.",
  seller: "SteelCraft Direct",
  location: "Pune, India",
  // deviceClass and imageUrl intentionally omitted
};

function renderCard(product: Product) {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <ProductCard product={product} />
    </LocaleProvider>,
  );
}

describe("ProductCard", () => {
  it("renders name and description text for a fully populated product", () => {
    renderCard(fullProduct);
    expect(
      screen.getByText("Digital Blood Pressure Monitor"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Automatic, cuff-based, clinical grade accuracy."),
    ).toBeInTheDocument();
  });

  it("renders the image block when imageUrl is present", () => {
    const { container } = renderCard(fullProduct);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
  });

  it("renders the translated device-class badge when deviceClass is present", () => {
    renderCard(fullProduct);
    expect(screen.getByText("Class B")).toBeInTheDocument();
  });

  it("renders one badge per certification", () => {
    renderCard(fullProduct);
    expect(screen.getByText("CE")).toBeInTheDocument();
    expect(screen.getByText("ISO 13485")).toBeInTheDocument();
  });

  it("renders the translated 'Price on request' string and a Send Inquiry button", () => {
    renderCard(fullProduct);
    expect(screen.getByText("Price on request")).toBeInTheDocument();
    // Accessible name includes the product name (aria-label), not just
    // the visible "Send Inquiry" text -- every card's button would
    // otherwise share the identical accessible name, which a
    // screen-reader user tabbing directly to it (the only interactive
    // element per card) can't distinguish from any other product's
    // button. Visible text itself is asserted separately below.
    expect(
      screen.getByRole("button", {
        name: "Send inquiry about Digital Blood Pressure Monitor",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the Send Inquiry button's visible text short regardless of the aria-label", () => {
    renderCard(fullProduct);
    expect(
      screen.getByRole("button", {
        name: "Send inquiry about Digital Blood Pressure Monitor",
      }),
    ).toHaveTextContent("Send Inquiry");
  });

  it("does not render an image block when imageUrl is absent", () => {
    const { container } = renderCard(minimalProduct);
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not render a device-class badge when deviceClass is absent", () => {
    renderCard(minimalProduct);
    expect(screen.queryByText(/^Class /)).not.toBeInTheDocument();
  });

  it("renders no certification badges and doesn't throw for an empty certifications array", () => {
    expect(() => renderCard(minimalProduct)).not.toThrow();
    // The other fixture's certs must not leak in; sanity-check none render.
    expect(screen.queryByText("CE")).not.toBeInTheDocument();
    expect(screen.queryByText("ISO 13485")).not.toBeInTheDocument();
  });

  it("still renders name/description/price/CTA for the minimal product", () => {
    renderCard(minimalProduct);
    expect(screen.getByText("Surgical Forceps Set")).toBeInTheDocument();
    expect(
      screen.getByText("Stainless steel, autoclavable forceps set."),
    ).toBeInTheDocument();
    expect(screen.getByText("Price on request")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Send inquiry about Surgical Forceps Set",
      }),
    ).toBeInTheDocument();
  });

  it("renders the product name as a real heading, not just styled text", () => {
    renderCard(fullProduct);
    expect(
      screen.getByRole("heading", {
        name: "Digital Blood Pressure Monitor",
        level: 2,
      }),
    ).toBeInTheDocument();
  });
});
