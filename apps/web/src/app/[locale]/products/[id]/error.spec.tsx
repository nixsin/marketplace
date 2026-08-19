// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductDetailError from "./error";
import { LocaleProvider } from "@/components/locale-provider";
import en from "../../../../../messages/en.json";

// A ninth review round (PR #94) claimed this component's prop should be
// named `reset`, not `retry`, citing generic Next.js App Router
// knowledge. Verified directly against this exact installed version's
// own docs before disputing it (apps/web/node_modules/next/dist/docs/
// 01-app/03-api-reference/03-file-conventions/error.md): that file's own
// version-history table states "v16.3.0 | retry prop became stable",
// and its own prose says "In most cases, you should use retry() instead"
// of the older reset(). `retry` is correct for this Next.js version --
// the reviewer's finding was disputed, not silently applied. What *was*
// a legitimate gap in the same finding: no test exercised this
// component's retry interaction at all (the e2e suite only covers the
// success and not-found paths, which never reach this boundary) -- this
// file closes that gap directly.
describe("ProductDetailError", () => {
  function renderError(retry: () => void) {
    return render(
      <LocaleProvider initialLocale="en" initialMessages={en}>
        <ProductDetailError retry={retry} />
      </LocaleProvider>,
    );
  }

  it("renders the translated error title and message", () => {
    renderError(vi.fn());
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByText("We couldn't load this product. Please try again."),
    ).toBeInTheDocument();
  });

  it("calls the retry callback when the button is clicked", async () => {
    const retry = vi.fn();
    renderError(retry);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
