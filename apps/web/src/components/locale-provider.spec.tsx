// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider, useLocaleSwitcher } from "./locale-provider";
import en from "../../messages/en.json";

// Small consumer that exercises useLocaleSwitcher() the way a real
// component would — reads locale/isSwitching for render output, and
// exposes a button per target locale to call switchLocale.
function LocaleConsumer() {
  const { locale, isSwitching, switchLocale } = useLocaleSwitcher();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="is-switching">{String(isSwitching)}</span>
      <button type="button" onClick={() => switchLocale("hi")}>
        switch-to-hi
      </button>
      <button type="button" onClick={() => switchLocale("en")}>
        switch-to-en
      </button>
    </div>
  );
}

function renderConsumer() {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <LocaleConsumer />
    </LocaleProvider>,
  );
}

describe("LocaleProvider / useLocaleSwitcher", () => {
  it("throws if used outside a LocaleProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<LocaleConsumer />)).toThrow(
      "useLocaleSwitcher must be used within LocaleProvider",
    );
    spy.mockRestore();
  });

  it("starts on the initial locale with isSwitching false", () => {
    renderConsumer();
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("is-switching")).toHaveTextContent("false");
  });

  it("treats switching to the already-current locale as a no-op", async () => {
    const user = userEvent.setup();
    renderConsumer();

    await user.click(screen.getByRole("button", { name: "switch-to-en" }));

    // No state change at all: still "en", isSwitching never flips to true
    // (the `if (next === locale) return;` early-return in switchLocale
    // means neither setLocale/setMessages nor startTransition ever run).
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("is-switching")).toHaveTextContent("false");
  });

  it("switches to a new locale, going through a real dynamic import", async () => {
    const user = userEvent.setup();
    renderConsumer();

    const originalLang = document.documentElement.lang;
    await user.click(screen.getByRole("button", { name: "switch-to-hi" }));

    // Async: goes through startTransition + a real dynamic import of
    // ../../messages/hi.json, so we must await rather than getBy*. `locale`
    // and `isSwitching` can land in separate renders under startTransition
    // (React may commit the pending->false flip a tick after the value
    // itself updates — more visible under coverage instrumentation's
    // different scheduling), so wait for both independently rather than
    // assuming they're settled in the same microtask.
    expect(await screen.findByTestId("locale")).toHaveTextContent("hi");
    await waitFor(() =>
      expect(screen.getByTestId("is-switching")).toHaveTextContent("false"),
    );

    // Side effect: document.documentElement.lang is updated by updateUrl().
    expect(document.documentElement.lang).toBe("hi");
    expect(document.documentElement.lang).not.toBe(originalLang);
  });

  it("reuses the cache on switching back, resolving synchronously the second time", async () => {
    const user = userEvent.setup();
    renderConsumer();

    // First switch to "hi": uncached, goes through the async
    // startTransition + dynamic-import path, so it needs an await/findBy*.
    await user.click(screen.getByRole("button", { name: "switch-to-hi" }));
    expect(await screen.findByTestId("locale")).toHaveTextContent("hi");
    await waitFor(() =>
      expect(screen.getByTestId("is-switching")).toHaveTextContent("false"),
    );

    // Switch back to "en" — already cached (seeded into the Map at
    // construction with the initial locale) — then to "hi" again, now also
    // cached from the first switch above. Per the source, a cache hit calls
    // setLocale/setMessages directly and returns, never touching
    // startTransition, so both switches commit synchronously: a plain
    // getBy* (not findBy*) query right after the click proves there was no
    // async gap, and is-switching should never have had a reason to flip.
    await user.click(screen.getByRole("button", { name: "switch-to-en" }));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("is-switching")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "switch-to-hi" }));
    expect(screen.getByTestId("locale")).toHaveTextContent("hi");
    expect(screen.getByTestId("is-switching")).toHaveTextContent("false");
  });
});
