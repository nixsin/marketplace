// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductCard, type Product } from "./product-card";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";

// ProductCard's heading now renders next-intl's <Link> (from
// @/i18n/navigation), which needs app-router context jsdom doesn't
// provide -- same mock, same reasoning, as pagination.spec.tsx/
// header.spec.tsx already established for this exact situation.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    className,
    children,
    ...props
  }: {
    href: string;
    className?: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

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

  it("links the heading to the product's detail page", () => {
    renderCard(fullProduct);
    expect(
      screen.getByRole("link", { name: "Digital Blood Pressure Monitor" }),
    ).toHaveAttribute("href", "/products/1");
  });

  it("links the image to the product too, so the whole photo is tappable", () => {
    const { container } = renderCard(fullProduct);
    const imageLink = container.querySelector("img")!.closest("a");
    expect(imageLink).toHaveAttribute("href", "/products/1");
  });

  it("hides the image link from assistive tech, since the heading already links there", () => {
    // Two links a few pixels apart pointing at the same product would make
    // a screen reader announce every card twice and add a redundant tab
    // stop per card -- the same "ambiguous in aggregate" problem already
    // fixed for this card's Send Inquiry button. The heading link stays
    // the single exposed path; the image is a pointer convenience.
    const { container } = renderCard(fullProduct);
    const imageLink = container.querySelector("img")!.closest("a")!;
    expect(imageLink).toHaveAttribute("aria-hidden", "true");
    expect(imageLink).toHaveAttribute("tabindex", "-1");
    // Exactly one link is still exposed by name, not two.
    expect(
      screen.getAllByRole("link", { name: "Digital Blood Pressure Monitor" }),
    ).toHaveLength(1);
  });

  it("keeps the inquiry button outside the link, which would be invalid HTML", () => {
    // The reason this is an image link and not a whole-card link: nesting
    // a <button> inside an <a> is invalid and gives the button two
    // conflicting activation behaviours.
    renderCard(fullProduct);
    const button = screen.getByRole("button", { name: /inquiry/i });
    expect(button.closest("a")).toBeNull();
  });

  it("lazy-loads the image by default", () => {
    const { container } = renderCard(fullProduct);
    expect(container.querySelector("img")).toHaveAttribute(
      "loading",
      "lazy",
    );
  });

  it("does not lazy-load the image when priority is set", () => {
    // Regression coverage for the LCP finding a live Lighthouse audit
    // caught on /hi?page=2 (see perf-budget.mjs's own comment): the
    // above-the-fold card on a direct page load must not be lazy-loaded.
    // Only asserts on `loading` -- confirmed directly (via the real
    // rendered outerHTML) that next/image sets fetchPriority as a DOM
    // property in this Next version's React 19 render path, not as a
    // static "fetchpriority" HTML attribute, so jsdom's attribute-based
    // queries can't observe it the way a real browser would; that part is
    // real-browser territory (see the Web e2e section's own jsdom-vs-
    // real-browser distinction), not something a component test can cover.
    const { container } = render(
      <LocaleProvider initialLocale="en" initialMessages={en}>
        <ProductCard product={fullProduct} priority />
      </LocaleProvider>,
    );
    expect(container.querySelector("img")).not.toHaveAttribute(
      "loading",
      "lazy",
    );
  });
});
