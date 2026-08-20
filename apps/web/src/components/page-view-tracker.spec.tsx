// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const pathname = vi.hoisted(() => ({ current: "/en" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const newPageView = vi.hoisted(() => vi.fn());
vi.mock("@/lib/correlation", () => ({ newPageView }));

import { PageViewTracker } from "./page-view-tracker";

describe("PageViewTracker", () => {
  beforeEach(() => {
    newPageView.mockClear();
    pathname.current = "/en";
  });

  it("does NOT start a page view on first render", () => {
    // The initial page view is created lazily by the first request that
    // needs one. Minting another here would split a single navigation
    // across two ids -- the requests before this effect runs would carry
    // one, everything after another.
    render(<PageViewTracker />);
    expect(newPageView).not.toHaveBeenCalled();
  });

  it("starts a new page view when the path changes", () => {
    // The finding this component answers: pageViewId is module-scoped, so
    // without this every request after hydration shared one id for the
    // whole visit.
    const { rerender } = render(<PageViewTracker />);
    expect(newPageView).not.toHaveBeenCalled();

    pathname.current = "/en/products/abc";
    rerender(<PageViewTracker />);
    expect(newPageView).toHaveBeenCalledTimes(1);
  });

  it("does not start one when the path is unchanged", () => {
    // A re-render for any other reason -- a locale switch, a parent state
    // change -- is not a navigation.
    const { rerender } = render(<PageViewTracker />);
    rerender(<PageViewTracker />);
    rerender(<PageViewTracker />);
    expect(newPageView).not.toHaveBeenCalled();
  });

  it("starts one per navigation, not one per render", () => {
    const { rerender } = render(<PageViewTracker />);
    pathname.current = "/hi";
    rerender(<PageViewTracker />);
    rerender(<PageViewTracker />);
    pathname.current = "/hi/products/xyz";
    rerender(<PageViewTracker />);
    expect(newPageView).toHaveBeenCalledTimes(2);
  });

  it("renders nothing", () => {
    const { container } = render(<PageViewTracker />);
    expect(container.innerHTML).toBe("");
  });
});
