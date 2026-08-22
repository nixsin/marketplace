// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";
import { INQUIRY_BULK_MAX_PRODUCTS } from "@medinstru/config";
import { ShortlistBar } from "./shortlist-bar";
import { submitBundleInquiry } from "@/lib/api";

vi.mock("@/lib/api", () => ({ submitBundleInquiry: vi.fn() }));
const submitMock = vi.mocked(submitBundleInquiry);

function renderBar(productIds: string[], onClear = vi.fn()) {
  render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <ShortlistBar productIds={productIds} onClear={onClear} />
    </LocaleProvider>,
  );
  return { onClear };
}

async function openAndSubmit() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /ask about these/i }));
  await user.type(screen.getByLabelText(/your name/i), "Asha Rao");
  await user.type(screen.getByLabelText(/your phone number/i), "+919000000001");
  await user.type(screen.getByLabelText(/your question/i), "Please quote.");
  await user.click(screen.getByRole("button", { name: /send inquiry for/i }));
}

describe("ShortlistBar", () => {
  beforeEach(() => {
    submitMock.mockResolvedValue({
      ok: true,
      productCount: 2,
      skippedCount: 0,
      delivered: true,
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("renders nothing at all when nothing is selected", () => {
    // A visitor who never shortlists should pay no layout, no focus stop and
    // no announcement for a feature they are not using.
    const { container } = render(
      <LocaleProvider initialLocale="en" initialMessages={en}>
        <ShortlistBar productIds={[]} onClear={vi.fn()} />
      </LocaleProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the count as items are selected", () => {
    renderBar(["p1", "p2", "p3"]);
    const count = screen.getByText(/3 products selected/i);
    // aria-live, or a screen-reader user has to go hunting for the number.
    expect(count).toHaveAttribute("aria-live", "polite");
  });

  it("uses singular wording for one product", () => {
    renderBar(["p1"]);
    expect(screen.getByText(/1 product selected/i)).toBeInTheDocument();
  });

  it("sends every selected id in one submission", async () => {
    renderBar(["p1", "p2"]);
    await openAndSubmit();

    expect(submitMock).toHaveBeenCalledWith({
      productIds: ["p1", "p2"],
      buyerName: "Asha Rao",
      buyerPhone: "+919000000001",
      message: "Please quote.",
    });
  });

  it("confirms receipt and clears the selection", async () => {
    const { onClear } = renderBar(["p1", "p2"]);
    await openAndSubmit();

    expect(await screen.findByRole("status")).toHaveTextContent(
      /inquiry received/i,
    );
    // Leaving them ticked after a successful send invites a duplicate.
    expect(onClear).toHaveBeenCalled();
  });

  it("says how many products were left out, rather than dropping them silently", async () => {
    // The buyer deliberately selected these; silently sending fewer looks
    // like the feature losing their input.
    submitMock.mockResolvedValue({
      ok: true,
      productCount: 1,
      skippedCount: 1,
      delivered: true,
    });
    renderBar(["p1", "p2"]);
    await openAndSubmit();

    expect(await screen.findByRole("status")).toHaveTextContent(
      /1 product was left out/i,
    );
  });

  it("announces a failure and keeps the selection", async () => {
    submitMock.mockResolvedValue({ ok: false, message: "network" });
    const { onClear } = renderBar(["p1", "p2"]);
    await openAndSubmit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Clearing on failure would destroy the shortlist they would want to retry.
    expect(onClear).not.toHaveBeenCalled();
  });

  it("blocks submission over the cap, and explains why before anything is typed", async () => {
    const tooMany = Array.from(
      { length: INQUIRY_BULK_MAX_PRODUCTS + 1 },
      (_, i) => `p${i}`,
    );
    renderBar(tooMany);

    expect(screen.getByRole("alert")).toHaveTextContent(/at most/i);
    expect(screen.getByRole("button", { name: /ask about these/i })).toBeDisabled();
  });

  it("lets the buyer back out without sending", async () => {
    const user = userEvent.setup();
    renderBar(["p1"]);
    await user.click(screen.getByRole("button", { name: /ask about these/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByLabelText(/your question/i)).not.toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });
});
