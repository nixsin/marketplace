// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HomeHeading } from "./home-heading";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";
import hi from "../../messages/hi.json";

describe("HomeHeading", () => {
  it("renders the title as a real heading and the subtitle text", () => {
    render(
      <LocaleProvider initialLocale="en" initialMessages={en}>
        <HomeHeading />
      </LocaleProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "Featured listings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Live from the catalog — MedInstru Market"),
    ).toBeInTheDocument();
  });

  it("renders the Hindi strings when mounted with the hi locale", () => {
    render(
      <LocaleProvider initialLocale="hi" initialMessages={hi}>
        <HomeHeading />
      </LocaleProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "विशेष लिस्टिंग" }),
    ).toBeInTheDocument();
  });
});
