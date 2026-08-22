import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { categorizeInquiryError, submitInquiry } from "./api";

/**
 * Direct tests for submitInquiry's own failure handling.
 *
 * The component tests mock this function entirely, so the parsing and
 * GraphQL-error branches inside it were never actually executed by anything —
 * a gap the review named explicitly. These drive the real function against a
 * stubbed fetch.
 */
const INPUT = {
  idempotencyKey: "test-submission-key-0001",
  productId: "seed-product-01",
  buyerName: "Asha Rao",
  buyerPhone: "+919000000001",
  message: "Is this available?",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("submitInquiry", () => {

  // headers included because reportApiFailure reads the correlation id off
  // the response; a stub without them fails for the wrong reason.
  function respond(body: unknown, ok = true) {
    fetchMock.mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      headers: new Headers(),
      json: () => Promise.resolve(body),
    });
  }

  it("reports success when the inquiry was recorded", async () => {
    respond({ data: { createInquiry: { id: "i1", status: "PENDING" } } });
    await expect(submitInquiry(INPUT)).resolves.toEqual({ ok: true });
  });

  it("reports NOTHING about delivery, because nothing delivers yet", async () => {
    // The result is a plain { ok: true }. Adding a flag here that the API
    // does not produce is how the confirmation copy starts claiming an
    // outcome nothing measured -- the exact failure the delivery change has
    // to avoid, and cheaper to guard now than to unpick later.
    respond({ data: { createInquiry: { id: "i1", status: "PENDING" } } });
    const result = await submitInquiry(INPUT);
    expect(Object.keys(result)).toEqual(["ok"]);
  });

  it("POSTs, so this can never be edge-cached", async () => {
    // A mutation must not be cacheable at any layer. The Cloudflare rules
    // bypass non-GET outright, which is what makes POST the guarantee.
    respond({ data: { createInquiry: { id: "i1" } } });
    await submitInquiry(INPUT);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
  });

  it("treats a GraphQL error as a failure despite the HTTP 200", async () => {
    // GraphQL reports resolver failures as 200 with an errors array, so
    // res.ok proves nothing about whether this worked.
    respond({ errors: [{ message: "Too many inquiries" }] });
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "rate-limited",
    });
  });

  it("does not throw when a 2xx body is not JSON", async () => {
    // A proxy error page or a cut connection. This used to throw past the
    // discriminated return, and the form has no catch — so it sat disabled
    // in "sending" forever on an unhandled rejection.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON")),
    });

    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("does not throw on an empty 2xx body", async () => {
    respond(null);
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("does not throw when the payload has neither data nor errors", async () => {
    respond({});
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("reports a non-2xx as a failure rather than throwing", async () => {
    respond({}, false);
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("reports a network failure rather than throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("categorizeInquiryError", () => {
  // The form used to render one fixed "check your phone number" for every
  // failure — wrong for a network error, actively misleading for a rate
  // limit, where retrying immediately cannot succeed and only adds traffic.
  it.each<[string, string]>([
    ["Too many inquiries from this number recently.", "rate-limited"],
    ["Too many inquiries right now. Please try again later.", "rate-limited"],
    ["You have already sent inquiries about this product recently.", "rate-limited"],
    ["Enter a valid phone number including the country code.", "invalid"],
    ["Enter your name and a question.", "invalid"],
  ])("maps %s to %s", (message, expected) => {
    expect(categorizeInquiryError(message)).toBe(expected);
  });

  it("falls back to unknown rather than guessing", () => {
    // A wrong category is worse than a generic one: it tells the buyer to do
    // something that cannot help.
    expect(categorizeInquiryError("Internal server error")).toBe("unknown");
    expect(categorizeInquiryError("")).toBe("unknown");
  });

  it("never returns raw server text to the caller", async () => {
    // Server messages can name internal state; the buyer gets a category.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          errors: [{ message: "Inquiry insert failed: relation does not exist" }],
        }),
    });

    const result = await submitInquiry(INPUT);
    expect(result).toEqual({ ok: false, reason: "unknown" });
  });
});
