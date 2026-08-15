// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { LanguageSwitcher } from "./language-switcher";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";

// LanguageSwitcher reads useTranslations (needs NextIntlClientProvider) and
// useLocaleSwitcher (needs LocaleProvider) — both real providers here, not
// mocked, since the point is verifying the actual wiring between them.
function renderSwitcher() {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <LanguageSwitcher />
    </LocaleProvider>,
  );
}

describe("LanguageSwitcher", () => {
  it("renders both locale options with English selected initially", () => {
    renderSwitcher();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("en");
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "हिन्दी" })).toBeInTheDocument();
  });

  it("switches locale on change, without needing a NextIntlClientProvider wrapper of its own", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const select = screen.getByRole("combobox") as HTMLSelectElement;

    await user.selectOptions(select, "hi");

    expect(select.value).toBe("hi");
  });

  it("throws if rendered outside a LocaleProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <NextIntlClientProvider locale="en" messages={en}>
          <LanguageSwitcher />
        </NextIntlClientProvider>,
      ),
    ).toThrow("useLocaleSwitcher must be used within LocaleProvider");
    spy.mockRestore();
  });
});
