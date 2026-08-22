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

// NOTE on the beforeEach bodies below: every one uses a BLOCK, never a
// concise arrow returning the mock.
//
// vitest treats a function returned from beforeEach as a teardown callback,
// and mockResolvedValue returns the MockInstance -- which is itself a
// function. So `beforeEach(() => mock.mockResolvedValue(x))` quietly CALLS
// the mock after every test in that block, with no arguments. Two symptoms
// came from this before it was understood: mock.calls carried a trailing
// entry with an undefined first argument (worked around with filter(Boolean)
// rather than fixed), and a test that installs a THROWING implementation
// failed with that throw after its assertions had already passed, reported
// with no assertion error at all.

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
    submitInquiryMock.mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.clearAllMocks());

  it("tells the buyer who receives their details before they type them", () => {
    // #91 story 5. Stated up front, not after submission.
    renderForm();
    const disclosure = screen.getByText(/recorded for this seller/i);
    expect(disclosure).toBeInTheDocument();
    // And it does not claim a transfer that has not happened. This is the
    // confirmation-copy defect one step earlier in the flow, at the point
    // where the buyer decides whether to type anything at all.
    expect(disclosure.textContent ?? "").not.toMatch(/shared with|sent to/i);
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
        // Generated per submission and reused across retries; its value is
        // not predictable, only its stability.
        idempotencyKey: expect.any(String) as string,
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

  it("claims the inquiry was RECORDED, and never that it was delivered", async () => {
    // The single most repeated finding on the unsplit version of this work,
    // in three separate rounds: copy that told the buyer the seller had their
    // question when nothing had been sent. A buyer who believes their message
    // arrived waits for a reply that cannot come, and does not retry.
    //
    // Nothing delivers yet, so there is exactly one honest wording, and the
    // assertions below are deliberately about what must NOT appear -- the
    // delivery change has to add a real outcome before any of it can.
    submitInquiryMock.mockResolvedValue({ ok: true });
    renderForm();
    await fillAndSubmit();

    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toMatch(/recorded/i);
    for (const claim of [
      /seller has your/i,
      /passed it to/i,
      /delivered/i,
      /sent to (the|this) seller/i,
      /on its way/i,
    ]) {
      expect(text).not.toMatch(claim);
    }
  });

  it("announces a failure and keeps what the buyer typed", async () => {
    submitInquiryMock.mockResolvedValue({ ok: false, reason: "network" as const });
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
    // Server messages can name internal state -- a database error, a limit
    // the buyer cannot see -- so the buyer gets a category they can act on.
    submitInquiryMock.mockResolvedValue({ ok: false, reason: "unknown" as const });
    renderForm();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").not.toMatch(/error|failed|exception/i);
  });

  it("disables the button while sending, so one click is one inquiry", async () => {
    let resolve: (v: { ok: true }) => void = () => {};
    submitInquiryMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderForm();
    await fillAndSubmit();

    const button = screen.getByRole("button", { name: /sending/i });
    expect(button).toBeDisabled();
    resolve({ ok: true });
  });

  it("locks EVERY field while sending, not just the button", async () => {
    // The button alone was disabled, so a buyer could edit the message while
    // the request was in flight and then be shown "recorded" for the values
    // already sent -- confirming something that did not happen, arriving
    // through the one door still left open.
    let resolve: (v: { ok: true }) => void = () => {};
    submitInquiryMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderForm();
    await fillAndSubmit();

    for (const label of [/your name/i, /your phone number/i, /your question/i]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    resolve({ ok: true });
  });

  it("unlocks the fields again after a failure, so a retry is possible", async () => {
    submitInquiryMock.mockResolvedValue({ ok: false, reason: "network" as const });
    renderForm();
    await fillAndSubmit();
    await screen.findByRole("alert");

    expect(screen.getByLabelText(/your question/i)).toBeEnabled();
  });

  it("labels the form with the product, so its purpose is clear out of context", () => {
    renderForm();
    expect(
      screen.getByRole("form", { name: /Digital X-Ray/i }),
    ).toBeInTheDocument();
  });
});

describe("InquiryForm resilience", () => {
  beforeEach(() => {
    submitInquiryMock.mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.clearAllMocks());

  it("is never STRANDED by an unexpected throw from the API layer", async () => {
    // submitInquiry returns a discriminated result rather than throwing, but
    // that is a property of its code, not a guarantee this form can rely on.
    // Before the fieldset a throw froze only the submit button; now it would
    // freeze every control, with no way back except a reload.
    // Thrown synchronously rather than returned as a rejected promise. The
    // form's try/catch covers both, and this shape does not leave vitest a
    // floating rejection to attribute to whichever test happens to be
    // running -- the throw IS the test's subject, so it must not also be
    // ambient noise.
    submitInquiryMock.mockImplementation(() => {
      throw new TypeError("toLowerCase of 42");
    });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText(/your question/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: /send inquiry/i })).toBeEnabled();
  });

  it("recovers when the API layer reports a malformed response", async () => {
    // A 2xx whose body is empty or not JSON used to throw past the API
    // function's discriminated return; with no catch in the form, it sat
    // disabled in "sending" forever on an unhandled rejection.
    submitInquiryMock.mockResolvedValue({ ok: false, reason: "network" as const });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Recoverable, not stuck.
    expect(
      screen.getByRole("button", { name: /send inquiry/i }),
    ).toBeEnabled();
  });
});

describe("submission idempotency", () => {
  beforeEach(() => {
    submitInquiryMock.mockResolvedValue({ ok: false, reason: "network" as const });
  });
  afterEach(() => vi.clearAllMocks());

  it("REUSES the same key when the buyer retries after a failure", async () => {
    // The whole mechanism depends on this. A lost response is
    // indistinguishable from a failure, so the retry must carry the same key
    // or the server sees a new submission -- a second inquiry now, and a
    // second message to the seller once delivery exists. Generating a fresh
    // key per attempt would look correct and silently defeat it.
    const user = userEvent.setup();
    renderForm();
    await fillAndSubmit();
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /send inquiry/i }));

    await waitFor(() =>
      expect(submitInquiryMock.mock.calls.length).toBeGreaterThan(1),
    );

    // EVERY attempt carries the same key -- asserted across all calls rather
    // than a fixed count, because how many times the form fires is an
    // implementation detail while key stability is the actual invariant.
    const keys = new Set(
      submitInquiryMock.mock.calls.map((c) => c[0].idempotencyKey),
    );
    expect(keys.size).toBe(1);
  });

  it("MINTS A NEW KEY when the buyer edits before retrying", async () => {
    // The opposite failure to the one above, and it was reproduced against a
    // real server: the buyer fixes their phone number and rewords the
    // question, the server matches the old key, returns the ORIGINAL row,
    // and the confirmation reports the edited inquiry as recorded. It never
    // was. The server now rejects that mismatch outright -- this is what
    // keeps a buyer from ever meeting the rejection, because an edit really
    // is a different submission.
    const user = userEvent.setup();
    renderForm();
    await fillAndSubmit();
    await screen.findByRole("alert");

    await user.clear(screen.getByLabelText(/your phone number/i));
    await user.type(screen.getByLabelText(/your phone number/i), "+919000000002");
    await user.click(screen.getByRole("button", { name: /send inquiry/i }));

    await waitFor(() =>
      expect(submitInquiryMock.mock.calls.length).toBeGreaterThan(1),
    );

    const calls = submitInquiryMock.mock.calls.map((c) => c[0]);
    const edited = calls.find((c) => c.buyerPhone === "+919000000002");
    const original = calls.find((c) => c.buyerPhone === "+919000000001");
    expect(edited?.idempotencyKey).not.toBe(original?.idempotencyKey);
  });
});
