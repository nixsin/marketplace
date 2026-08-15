// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Header renders `<Link>` from `@/i18n/navigation` — next-intl's
// `createNavigation(routing)` helper. That helper imports `next/navigation`
// (for useRouter/usePathname) at module scope, and in this monorepo's pnpm
// layout that import fails to resolve entirely under plain Vitest/jsdom
// (nested next-intl -> next symlink, no real Next.js app-router runtime
// present) — it's a resolution-time crash, not something a runtime stub of
// next/navigation's exports can fix, since the module graph never gets that
// far. None of the links Header renders pass a `locale` prop, so real
// next-intl Link behavior (which is what would call those hooks) never
// actually engages here anyway — so instead of fighting the resolution
// chain, we replace `@/i18n/navigation` itself with a plain anchor-based
// stub that mirrors the bits Header relies on (href, className, children;
// prefetch is a Next-only concept with no <a> equivalent, so it's dropped).
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children?: React.ReactNode;
    prefetch?: boolean;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const { Header } = await import("./header");
const { LocaleProvider } = await import("./locale-provider");
const en = (await import("../../messages/en.json")).default;

function renderHeader() {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <Header />
    </LocaleProvider>,
  );
}

const navLinkNames = [
  en.header.categories,
  en.header.sellOnMedInstru,
  en.header.signIn,
];

describe("Header", () => {
  it("renders the desktop nav (with all links + language switcher) and the mobile trigger button on initial mount", () => {
    renderHeader();

    // Desktop nav: a <nav> that carries the sm:flex class, present
    // unconditionally in the DOM (jsdom doesn't evaluate the sm: media
    // query, so we only assert on structure/classes, not visibility).
    const navs = screen.getAllByRole("navigation");
    const desktopNav = navs.find((nav) => nav.className.includes("sm:flex"));
    expect(desktopNav).toBeDefined();
    for (const name of navLinkNames) {
      expect(within(desktopNav!).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(desktopNav!).getByRole("combobox")).toBeInTheDocument();

    // Mobile trigger button.
    const trigger = screen.getByRole("button", { name: en.header.menu });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass("sm:hidden");
  });

  it("starts with aria-expanded false and no #mobile-nav panel in the document", () => {
    renderHeader();

    const trigger = screen.getByRole("button", { name: en.header.menu });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "mobile-nav");

    // Header only renders the `#mobile-nav` panel when menuOpen is true
    // (`{menuOpen && (...)}`) — it's absent from the DOM entirely, not just
    // hidden via CSS, so querySelector should find nothing.
    expect(document.getElementById("mobile-nav")).not.toBeInTheDocument();
  });

  it("opens the mobile nav panel on click, with all links and the language switcher, and flips aria-expanded to true", async () => {
    const user = userEvent.setup();
    renderHeader();

    const trigger = screen.getByRole("button", { name: en.header.menu });
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const panel = document.getElementById("mobile-nav");
    expect(panel).toBeInTheDocument();
    for (const name of navLinkNames) {
      expect(within(panel!).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(panel!).getByRole("combobox")).toBeInTheDocument();
  });

  it("closes the mobile nav panel on a second click, restoring aria-expanded to false", async () => {
    const user = userEvent.setup();
    renderHeader();

    const trigger = screen.getByRole("button", { name: en.header.menu });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("mobile-nav")).toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("mobile-nav")).not.toBeInTheDocument();
  });

  it("resolves the trigger's aria-label from the translated header.menu string", () => {
    renderHeader();
    expect(en.header.menu).toBe("Menu");
    expect(
      screen.getByRole("button", { name: en.header.menu }),
    ).toHaveAttribute("aria-label", "Menu");
  });
});
