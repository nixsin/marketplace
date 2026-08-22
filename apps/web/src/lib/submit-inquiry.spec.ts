import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { submitInquiry } from "./api";

/**
 * Direct tests for submitInquiry's own failure handling.
 *
 * The component tests mock this function entirely, so the parsing and
 * GraphQL-error branches inside it were never actually executed by anything —
 * a gap the review named explicitly. These drive the real function against a
 * stubbed fetch.
 */
describe("submitInquiry", () => {
  const INPUT = {
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

  it("returns the delivery flag on success", async () => {
    respond({ data: { createInquiry: { id: "i1", delivered: true } } });
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: true,
      delivered: true,
    });
  });

  it("POSTs, so this can never be edge-cached", async () => {
    // A mutation must not be cacheable at any layer. The Cloudflare rules
    // bypass non-GET outright, which is what makes POST the guarantee.
    respond({ data: { createInquiry: { delivered: false } } });
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
      message: "Too many inquiries",
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
      message: "network",
    });
  });

  it("does not throw on an empty 2xx body", async () => {
    respond(null);
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      message: "unknown",
    });
  });

  it("does not throw when the payload has neither data nor errors", async () => {
    respond({});
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      message: "unknown",
    });
  });

  it("reports a non-2xx as a failure rather than throwing", async () => {
    respond({}, false);
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      message: "network",
    });
  });

  it("reports a network failure rather than throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(submitInquiry(INPUT)).resolves.toEqual({
      ok: false,
      message: "network",
    });
  });
});
