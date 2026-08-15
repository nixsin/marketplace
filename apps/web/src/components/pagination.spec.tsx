// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pagination } from "./pagination";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";

// Pagination renders next-intl's <Link> (from @/i18n/navigation), which
// internally reaches into next/navigation's app-router hooks for locale
// prefixing — those have no context in plain jsdom. Mocking "next/navigation"
// directly doesn't work here: next-intl resolves its own nested copy of the
// "next" package, and Vitest's native module resolver can't locate the
// mocked bare specifier there (no "exports" map on that nested package, and
// no automatic ".js" extension probing for a vi.mock'd id). Mocking our own
// thin wrapper (@/i18n/navigation) instead sidesteps that chain entirely and
// is just as faithful to what Pagination actually renders (a real <a> with
// the href/className it computed).
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

function renderPagination(currentPage: number, totalPages: number) {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <Pagination currentPage={currentPage} totalPages={totalPages} />
    </LocaleProvider>,
  );
}

describe("Pagination", () => {
  it("renders nothing when totalPages <= 1", () => {
    const { container: c1 } = renderPagination(1, 1);
    expect(c1).toBeEmptyDOMElement();

    const { container: c2 } = renderPagination(1, 0);
    expect(c2).toBeEmptyDOMElement();
  });

  it.each([
    [1, 3, 3],
    [1, 10, 10],
    [1, 25, 10],
  ])(
    "renders Math.min(totalPages, 10) numbered page links (currentPage=%i, totalPages=%i -> %i links)",
    (currentPage, totalPages, expectedCount) => {
      renderPagination(currentPage, totalPages);
      // Numbered page links/spans are those whose accessible name is a
      // plain number, excluding the "Previous"/"Next" controls.
      const numberEls = screen
        .getAllByText(/^\d+$/)
        .filter((el) => /^(a|span)$/i.test(el.tagName));
      expect(numberEls).toHaveLength(expectedCount);
    },
  );

  it("marks the current page as active via styling, while both stay real Links", () => {
    renderPagination(3, 5);

    // active is a pure styling flag (bg-primary/text-primary-foreground) —
    // only `disabled` changes the element type to <span>. Both the active
    // and inactive page here are still clickable <Link>s (<a>).
    const activePage = screen.getByText("3");
    expect(activePage.tagName).toBe("A");
    expect(activePage.className).toContain("bg-primary");
    expect(activePage.className).toContain("text-primary-foreground");

    const otherPage = screen.getByText("2");
    expect(otherPage.tagName).toBe("A");
    expect(otherPage.className).not.toContain("bg-primary");
  });

  it("disables Previous as a non-interactive span when currentPage <= 1", () => {
    renderPagination(1, 5);
    const prev = screen.getByText("Previous");
    expect(prev.tagName).toBe("SPAN");
    expect(prev.className).toContain("pointer-events-none");
  });

  it("renders Previous as an enabled Link when currentPage > 1", () => {
    renderPagination(2, 5);
    const prev = screen.getByText("Previous");
    expect(prev.tagName).toBe("A");
    expect(prev.className).not.toContain("pointer-events-none");
    expect(prev.getAttribute("href")).toBe("/?page=1");
  });

  it("disables Next as a non-interactive span when currentPage >= totalPages", () => {
    renderPagination(5, 5);
    const next = screen.getByText("Next");
    expect(next.tagName).toBe("SPAN");
    expect(next.className).toContain("pointer-events-none");
  });

  it("renders Next as an enabled Link when currentPage < totalPages", () => {
    renderPagination(2, 5);
    const next = screen.getByText("Next");
    expect(next.tagName).toBe("A");
    expect(next.className).not.toContain("pointer-events-none");
    expect(next.getAttribute("href")).toBe("/?page=3");
  });

  it("gives numbered page links the correct href (/?page=N pattern)", () => {
    renderPagination(1, 5);
    const page4 = screen.getByText("4");
    expect(page4.getAttribute("href")).toBe("/?page=4");
  });

  it("renders exactly one navigation landmark", () => {
    renderPagination(1, 5);
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeInTheDocument();
  });
});
