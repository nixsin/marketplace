// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Footer } from "./footer";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";

function renderFooter() {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <Footer />
    </LocaleProvider>,
  );
}

describe("Footer", () => {
  it("renders the rights line with the current year interpolated", () => {
    renderFooter();
    const year = new Date().getFullYear().toString();
    expect(screen.getByText(new RegExp(year))).toBeInTheDocument();
  });

  it("renders all four footer links' text", () => {
    renderFooter();
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.getByText("Contact")).toBeInTheDocument();
    expect(screen.getByText("Terms")).toBeInTheDocument();
    expect(screen.getByText("Privacy")).toBeInTheDocument();
  });

  it("renders as a real <footer> landmark", () => {
    renderFooter();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});
