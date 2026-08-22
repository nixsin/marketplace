// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider } from "./locale-provider";
import en from "../../messages/en.json";
import { InquiryForm } from "./inquiry-form";
import { submitInquiry } from "@/lib/api";

vi.mock("@/lib/api", () => ({ submitInquiry: vi.fn() }));

const submitInquiryMock = vi.mocked(submitInquiry);

function renderForm() {
  return render(
    <LocaleProvider initialLocale="en" initialMessages={en}>
      <InquiryForm productId="seed-product-01" productName="Digital X-Ray" />
    </LocaleProvider>,
  );
}

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/your name/i), "Asha Rao");
  await user.type(screen.getByLabelText(/your phone number/i), "+919000000001");
  await user.type(screen.getByLabelText(/your question/i), "Available in Chennai?");
  await user.click(screen.getByRole("button", { name: /send inquiry/i }));
}

describe("InquiryForm", () => {
  beforeEach(() => {
    submitInquiryMock.mockResolvedValue({ ok: true, delivered: true });
  });
  afterEach(() => vi.clearAllMocks());

  it("tells the buyer who receives their details before they type them", () => {
    // #91 story 5. Stated up front, not after submission.
    renderForm();
    expect(screen.getByText(/go to this seller on WhatsApp/i)).toBeInTheDocument();
  });

  it("says an inquiry is not marketing consent", () => {
    // #91 story 10.
    renderForm();
    expect(
      screen.getByText(/does not sign you up for marketing messages/i),
    ).toBeInTheDocument();
  });

  it("submits what the buyer typed", async () => {
    renderForm();
    await fillAndSubmit();

    await waitFor(() =>
      expect(submitInquiryMock).toHaveBeenCalledWith({
        productId: "seed-product-01",
        buyerName: "Asha Rao",
        buyerPhone: "+919000000001",
        message: "Available in Chennai?",
      }),
    );
  });

  it("trims whitespace so a stray space is not sent as part of a phone number", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText(/your name/i), "  Asha Rao  ");
    await user.type(screen.getByLabelText(/your phone number/i), " +919000000001 ");
    await user.type(screen.getByLabelText(/your question/i), " hello ");
    await user.click(screen.getByRole("button", { name: /send inquiry/i }));

    await waitFor(() =>
      expect(submitInquiryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          buyerName: "Asha Rao",
          buyerPhone: "+919000000001",
          message: "hello",
        }),
      ),
    );
  });

  it("confirms receipt, and announces it", async () => {
    renderForm();
    await fillAndSubmit();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/inquiry received/i);
    // The form is replaced, so a screen-reader user needs the result
    // announced rather than silently swapped in.
    expect(screen.queryByLabelText(/your question/i)).not.toBeInTheDocument();
  });

  it("does not claim the seller has the message when delivery failed", async () => {
    // The earlier copy said "The seller has your question and your number"
    // and was shown even when delivered was false -- a flat false claim, and
    // the old test only checked for the literal word "delivered", which
    // missed the semantic one entirely.
    submitInquiryMock.mockResolvedValue({ ok: true, delivered: false });
    renderForm();
    await fillAndSubmit();

    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).not.toMatch(/delivered/i);
    expect(text).not.toMatch(/the seller has/i);
    // What we actually know: it is recorded.
    expect(text).toMatch(/recorded/i);
  });

  it("still confirms receipt when delivery failed", async () => {
    // The lead IS recorded server-side. Telling the buyer it failed would
    // invite them to resend into the same wall.
    submitInquiryMock.mockResolvedValue({ ok: true, delivered: false });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByRole("status")).toHaveTextContent(
      /inquiry received/i,
    );
  });

  it("announces a failure and keeps what the buyer typed", async () => {
    submitInquiryMock.mockResolvedValue({ ok: false, message: "network" });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Losing a filled-in form on a failed submit is the fastest way to make
    // someone give up rather than retry.
    expect(screen.getByLabelText(/your question/i)).toHaveValue(
      "Available in Chennai?",
    );
  });

  it("never surfaces the raw server error to the buyer", async () => {
    // Server messages can name internal state ("seller has no WhatsApp
    // number"); the buyer gets something they can act on instead.
    submitInquiryMock.mockResolvedValue({
      ok: false,
      message: "seller has no WhatsApp number",
    });
    renderForm();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").not.toContain("seller has no WhatsApp");
  });

  it("disables the button while sending, so one click is one inquiry", async () => {
    let resolve: (v: { ok: true; delivered: boolean }) => void = () => {};
    submitInquiryMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderForm();
    await fillAndSubmit();

    const button = screen.getByRole("button", { name: /sending/i });
    expect(button).toBeDisabled();
    resolve({ ok: true, delivered: true });
  });

  it("labels the form with the product, so its purpose is clear out of context", () => {
    renderForm();
    expect(
      screen.getByRole("form", { name: /Digital X-Ray/i }),
    ).toBeInTheDocument();
  });
});

describe("InquiryForm resilience", () => {
  beforeEach(() =>
    submitInquiryMock.mockResolvedValue({ ok: true, delivered: true }),
  );
  afterEach(() => vi.clearAllMocks());

  it("recovers when the API layer reports a malformed response", async () => {
    // A 2xx whose body is empty or not JSON used to throw past the API
    // function's discriminated return; with no catch in the form, it sat
    // disabled in "sending" forever on an unhandled rejection.
    submitInquiryMock.mockResolvedValue({ ok: false, message: "network" });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Recoverable, not stuck.
    expect(
      screen.getByRole("button", { name: /send inquiry/i }),
    ).toBeEnabled();
  });
});
