import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  categorizeInquiryError,
  retryAfterFrom,
  submitInquiry,
} from "./api";

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
    respond({
      errors: [
        {
          message: "Too many inquiries",
          extensions: { code: "TOO_MANY_REQUESTS", retryAfterMs: 720_000 },
        },
      ],
    });
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "rate-limited",
      // Passed through so the UI can say WHEN to try again rather than
      // "later". Only ever present on a throttle the server dated.
      retryAfterMs: 720_000,
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

  it.each([
    ["an empty object", {}],
    ["a null id", { id: null }],
    ["an empty-string id", { id: "" }],
    ["a non-string id", { id: 42 }],
  ])("does not report success for a payload with %s", async (_label, node) => {
    // Every one of these is TRUTHY as an object, and a bare truthiness test
    // reported them all as a recorded inquiry -- the same defect as
    // confirmation copy claiming an outcome nothing produced, one layer down.
    respond({ data: { createInquiry: node } });
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

  it.each([
    ["a numeric message", 42],
    ["a null message", null],
    ["an object message", { nested: true }],
    ["no message at all", undefined],
  ])("does not throw on an error entry with %s", async (_label, message) => {
    // `errors` comes off the wire, so a broken intermediary can put anything
    // in it. This mattered more when the message was READ -- categorize
    // called .toLowerCase() on it, which threw past this function's
    // discriminated return. It now reads only extensions.code, so a strange
    // message is inert; these cases stay because the guarantee callers rely
    // on is the discriminated result, not the reason it holds today.
    respond({ errors: [{ message }] });
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      reason: "unknown",
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
  const err = (code: string) => ({ message: "irrelevant", extensions: { code } });

  it.each<[string, string]>([
    ["TOO_MANY_REQUESTS", "rate-limited"],
    ["CONFLICT", "conflict"],
    ["BAD_USER_INPUT", "invalid"],
  ])("maps the %s code to %s", (code, expected) => {
    expect(categorizeInquiryError(err(code))).toBe(expected);
  });

  it("IGNORES the message entirely, whatever it says", () => {
    // The whole point of the change. This used to match substrings of the
    // server's prose, which made the wording a load-bearing API -- and it
    // broke: the conflict message once read "already sent with different
    // details", the rate-limit branch matched "already sent", and a buyer
    // whose submission id collided was told they had sent too many inquiries
    // recently, pointing them at a wait that could not help.
    //
    // Each of these carries text that would have matched the WRONG branch
    // under the old prose matching.
    expect(
      categorizeInquiryError({
        message: "Too many inquiries right now.",
        extensions: { code: "CONFLICT" },
      }),
    ).toBe("conflict");
    expect(
      categorizeInquiryError({
        message: "This submission id was already used.",
        extensions: { code: "TOO_MANY_REQUESTS" },
      }),
    ).toBe("rate-limited");
  });

  it("falls back to unknown rather than guessing", () => {
    // A wrong category is worse than a generic one: it tells the buyer to do
    // something that cannot help. This is also the ROLLBACK path -- an API
    // deployed from before codes existed sends none, and every buyer sees
    // generic copy rather than wrong copy.
    expect(categorizeInquiryError(undefined)).toBe("unknown");
    expect(categorizeInquiryError({ message: "Internal server error" })).toBe(
      "unknown",
    );
    expect(categorizeInquiryError({ extensions: { code: "SOMETHING_NEW" } })).toBe(
      "unknown",
    );
    // Not a string, because it came off the wire.
    expect(categorizeInquiryError({ extensions: { code: 42 } })).toBe("unknown");
  });

  describe("retryAfterFrom", () => {
    it("reads a usable hint", () => {
      expect(retryAfterFrom({ extensions: { retryAfterMs: 720_000 } })).toBe(
        720_000,
      );
    });

    it("returns null when the server dated nothing", () => {
      // Absent is meaningfully different from zero: it means the server could
      // not date the wait, which is guidance to give none -- not to retry now.
      expect(retryAfterFrom(undefined)).toBeNull();
      expect(retryAfterFrom({ extensions: {} })).toBeNull();
      expect(retryAfterFrom({ extensions: { retryAfterMs: 0 } })).toBeNull();
      expect(retryAfterFrom({ extensions: { retryAfterMs: -5 } })).toBeNull();
      expect(retryAfterFrom({ extensions: { retryAfterMs: "soon" } })).toBeNull();
      expect(retryAfterFrom({ extensions: { retryAfterMs: NaN } })).toBeNull();
    });
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
