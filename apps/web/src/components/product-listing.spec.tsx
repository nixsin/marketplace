// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ProductListing } from "./product-listing";
import { LocaleProvider } from "./locale-provider";
import type { Product } from "./product-card";
import { fetchProductsPaged } from "@/lib/api";
import en from "../../messages/en.json";

// ProductListing reads the current page directly from next/navigation's
// useSearchParams — stub it so we control what page it thinks it's on.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("page=2"),
}));

// fetchProductsPaged normally hits a real GraphQL endpoint over fetch() —
// mock it so tests control exactly what resolves and when.
vi.mock("@/lib/api", () => ({
  fetchProductsPaged: vi.fn(),
}));

// ProductListing renders Pagination, which renders next-intl's <Link>
// (@/i18n/navigation) — that reaches into next/navigation's app-router
// hooks (useParams/usePathname) for locale prefixing, which have no
// context in plain jsdom. Mocking next/navigation further (beyond
// useSearchParams above) hits an unrelated resolution snag: next-intl
// resolves its own nested copy of "next", and Vitest's native resolver
// can't locate a mocked bare specifier there. Mocking our own thin wrapper
// sidesteps that chain entirely — same approach as pagination.spec.tsx.
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

const mockedFetchProductsPaged = vi.mocked(fetchProductsPaged);

const product1: Product = {
  id: "1",
  name: "Digital Blood Pressure Monitor",
  brand: "MedTech",
  category: "Diagnostics",
  deviceClass: "B",
  certifications: ["CE"],
  description: "Automatic, cuff-based, clinical grade accuracy.",
  imageUrl: "https://example.com/bp-monitor.jpg",
  seller: "Acme Medical Supplies",
  location: "Mumbai, India",
};

const product2: Product = {
  id: "2",
  name: "Surgical Forceps Set",
  brand: "SteelCraft",
  category: "Surgical",
  certifications: [],
  description: "Stainless steel, autoclavable forceps set.",
  seller: "SteelCraft Direct",
  location: "Pune, India",
};

function renderListing() {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <ProductListing />
    </LocaleProvider>,
  );
}

describe("ProductListing", () => {
  it("renders 4 loading skeleton placeholders before the fetch resolves", () => {
    mockedFetchProductsPaged.mockReturnValue(new Promise(() => {}));
    const { container } = renderListing();

    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons).toHaveLength(4);
  });

  it("renders both products once the fetch resolves, and clears the skeletons", async () => {
    mockedFetchProductsPaged.mockResolvedValue({
      items: [product1, product2],
      page: 1,
      pageSize: 4,
      totalCount: 2,
      totalPages: 1,
    });
    const { container } = renderListing();

    expect(
      await screen.findByText("Digital Blood Pressure Monitor"),
    ).toBeInTheDocument();
    expect(screen.getByText("Surgical Forceps Set")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("renders no product cards and doesn't crash for an empty result", async () => {
    mockedFetchProductsPaged.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 4,
      totalCount: 0,
      totalPages: 1,
    });
    const { container } = renderListing();

    // Wait for the loading state to clear (skeletons gone) as our async signal.
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    });
    expect(screen.queryByRole("button", { name: "Send Inquiry" })).not.toBeInTheDocument();
  });

  it("reads the page param from useSearchParams and forwards it to fetchProductsPaged", async () => {
    mockedFetchProductsPaged.mockResolvedValue({
      items: [product1],
      page: 2,
      pageSize: 4,
      totalCount: 5,
      totalPages: 2,
    });
    renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    expect(mockedFetchProductsPaged).toHaveBeenCalledWith(2);
  });

  it("renders Pagination when totalPages > 1", async () => {
    mockedFetchProductsPaged.mockResolvedValue({
      items: [product1],
      page: 2,
      pageSize: 4,
      totalCount: 5,
      totalPages: 2,
    });
    renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(within(nav).getByText("Next")).toBeInTheDocument();
  });

  it("does not render Pagination when totalPages <= 1", async () => {
    mockedFetchProductsPaged.mockResolvedValue({
      items: [product1],
      page: 1,
      pageSize: 4,
      totalCount: 1,
      totalPages: 1,
    });
    renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    expect(
      screen.queryByRole("navigation", { name: "Pagination" }),
    ).not.toBeInTheDocument();
  });
});
