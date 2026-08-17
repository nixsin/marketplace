// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ProductListing } from "./product-listing";
import { LocaleProvider } from "./locale-provider";
import type { Product } from "./product-card";
import { fetchProductsPaged } from "@/lib/api";
import en from "../../messages/en.json";

// ProductListing reads the current page directly from next/navigation's
// useSearchParams — stub it so we control what page it thinks it's on.
// A real vi.fn(), not a fixed factory return, so a test can change what
// it returns mid-test and force ProductListing's effects to refire, the
// same way a real pagination click would (needed for the prefetch tests
// below, which simulate a page transition). Every other test sets it back
// to a fixed "page=2" first, matching this file's original fixed-mock
// behavior exactly.
const mockUseSearchParams = vi.fn(() => new URLSearchParams("page=2"));
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockUseSearchParams(),
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
  // mockedFetchProductsPaged is one shared mock across every test in this
  // file (module-level, not re-created per test) -- without clearing its
  // call history, toHaveBeenCalledTimes assertions accumulate the count
  // from every preceding test, not just the current one. Earlier tests in
  // this file only ever asserted toHaveBeenCalledWith (which doesn't care
  // how many prior calls there were), so this was a real, latent gap that
  // only became visible once tests asserting an exact count were added
  // (the prefetch tests below) -- confirmed directly: without this,
  // "expected 1 call, got 9" / "expected 2 calls, got 11", where 9 and 11
  // are exactly the running total including every earlier test's own
  // calls, not a bug in the prefetch logic itself.
  beforeEach(() => {
    mockedFetchProductsPaged.mockClear();
  });


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

  // The tests below cover #75: prefetching the anticipated next page so a
  // pagination click renders instantly, and its out-of-sequence-navigation
  // edge case. Each page in this fixture set is deliberately distinct
  // content (not just a different page number) so a test can tell *which*
  // page actually ended up on screen, not just that *a* page did.
  const product3: Product = {
    id: "3",
    name: "Portable Ultrasound Scanner",
    brand: "ScanTech",
    category: "Diagnostics",
    certifications: ["CE"],
    description: "Handheld, battery-powered ultrasound unit.",
    imageUrl: "https://example.com/ultrasound.jpg",
    seller: "ScanTech Direct",
    location: "Delhi, India",
  };

  function mockPageContent(
    byPage: Record<number, { items: Product[]; totalPages: number }>,
  ) {
    mockedFetchProductsPaged.mockImplementation(async (page = 1) => {
      const page_ = byPage[page];
      return {
        items: page_.items,
        page,
        pageSize: 4,
        totalCount: page_.items.length,
        totalPages: page_.totalPages,
      };
    });
  }

  it("prefetches the next page once the current page finishes loading", async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams("page=1"));
    mockPageContent({
      1: { items: [product1], totalPages: 2 },
      2: { items: [product2], totalPages: 2 },
    });
    renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    await vi.waitFor(() => {
      expect(mockedFetchProductsPaged).toHaveBeenCalledWith(2);
    });
  });

  it("does not prefetch when the current page is the last page", async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams("page=1"));
    mockPageContent({ 1: { items: [product1], totalPages: 1 } });
    renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    // Give any errant prefetch effect a chance to fire before asserting
    // it didn't -- vi.waitFor's own polling loop is a convenient way to
    // let a few microtask/macrotask turns pass without a bare setTimeout.
    await vi.waitFor(() => {
      expect(mockedFetchProductsPaged).toHaveBeenCalledTimes(1);
    });
  });

  it("renders a prefetched page instantly, with no additional fetch call, when the user navigates there", async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams("page=1"));
    mockPageContent({
      1: { items: [product1], totalPages: 2 },
      2: { items: [product2], totalPages: 2 },
    });
    const { rerender } = renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    // Wait for the background prefetch of page 2 to actually complete
    // (not just fire) before navigating -- otherwise this test can't tell
    // "used the cache" apart from "the fetch just happened to be fast".
    await vi.waitFor(() => {
      expect(mockedFetchProductsPaged).toHaveBeenCalledTimes(2);
    });

    mockUseSearchParams.mockReturnValue(new URLSearchParams("page=2"));
    rerender(
      <LocaleProvider initialLocale="en" initialMessages={en}>
        <ProductListing />
      </LocaleProvider>,
    );

    await screen.findByText("Surgical Forceps Set");
    // Still exactly 2 calls: the real page-1 fetch and the page-2
    // prefetch. A 3rd call here would mean the transition re-fetched
    // page 2 instead of using the already-warmed cache.
    expect(mockedFetchProductsPaged).toHaveBeenCalledTimes(2);
  });

  it("falls back to a fresh fetch for a page that was never prefetched (out-of-sequence navigation)", async () => {
    // The story's explicit edge case: jumping straight from page 1 to
    // page 3 skips right past the page-2 prefetch this component only
    // ever speculatively warms one page ahead.
    mockUseSearchParams.mockReturnValue(new URLSearchParams("page=1"));
    mockPageContent({
      1: { items: [product1], totalPages: 3 },
      2: { items: [product2], totalPages: 3 },
      3: { items: [product3], totalPages: 3 },
    });
    const { rerender } = renderListing();

    await screen.findByText("Digital Blood Pressure Monitor");
    await vi.waitFor(() => {
      // The page-2 prefetch has to have actually happened first, or this
      // test wouldn't be distinguishing "skipped the prefetch" from
      // "there was never a prefetch to skip".
      expect(mockedFetchProductsPaged).toHaveBeenCalledWith(2);
    });

    mockUseSearchParams.mockReturnValue(new URLSearchParams("page=3"));
    rerender(
      <LocaleProvider initialLocale="en" initialMessages={en}>
        <ProductListing />
      </LocaleProvider>,
    );

    // Falls back to exactly the pre-existing fetch-then-render path --
    // a real, fresh call for page 3, and the right content once it
    // resolves.
    await vi.waitFor(() => {
      expect(mockedFetchProductsPaged).toHaveBeenCalledWith(3);
    });
    await screen.findByText("Portable Ultrasound Scanner");
  });
});
