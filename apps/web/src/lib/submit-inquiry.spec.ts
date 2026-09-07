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
  describe("an unknown failure is debuggable", () => {
    // Raised in review: "unknown" is the one category the buyer cannot act on
    // AND the operator cannot diagnose. Several unrelated situations collapse
    // into it and, from a support ticket, are indistinguishable.
    //
    // Each is reported through reportApiFailure, so it carries the same two
    // correlation ids every other failure here does -- which is what turns a
    // browser error into something findable in the server log.
    const report = () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      return {
        spy,
        text: () => spy.mock.calls.map((c) => JSON.stringify(c)).join(" "),
      };
    };

    it("names an UNHANDLED code, with the ids to trace it", async () => {
      const { spy, text } = report();
      try {
        respond({
          errors: [
            {
              message: "Seller is on holiday",
              extensions: { code: "SELLER_UNAVAILABLE" },
            },
          ],
        });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });

        const logged = text();
        // The code, so the gap in this client is identifiable...
        expect(logged).toContain("SELLER_UNAVAILABLE");
        // ...the server's own words, so it can be matched to a throw site...
        expect(logged).toContain("Seller is on holiday");
        // ...and the id that finds the server log for THIS request.
        expect(logged).toContain("client_request_id");
      } finally {
        spy.mockRestore();
      }
    });

    it("distinguishes a MISSING code, which means a rollback", async () => {
      // Degrading is correct; not knowing the API went backwards is not.
      const { spy, text } = report();
      try {
        respond({ errors: [{ message: "Bad Request Exception" }] });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });
        expect(text()).toContain("none");
      } finally {
        spy.mockRestore();
      }
    });

    it("names a response carrying neither an error nor an id", async () => {
      // Nothing should be shaped this way, which is why it is worth naming
      // distinctly: reaching it means schema drift or an intermediary
      // rewriting the body, not an error the API chose to send.
      const { spy, text } = report();
      try {
        respond({ data: { createInquiry: {} } });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });
        expect(text()).toContain("no usable inquiry id");
      } finally {
        spy.mockRestore();
      }
    });

    it("stays SILENT for a category it handles", async () => {
      // A report on every ordinary rate limit would bury the ones that matter.
      const { spy } = report();
      try {
        respond({
          errors: [
            { message: "x", extensions: { code: "TOO_MANY_REQUESTS" } },
          ],
        });
        await submitInquiry(INPUT);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("every state this can reach", () => {
    // Enumerated from the decision points rather than the cases anyone
    // happened to think of. Two were being silently collapsed before this
    // existed: `errors: []` fell through and was reported as a missing id,
    // and a literal null body was reported as a wrong SHAPE.
    //
    // Named as what the BUYER is doing, so a row can be checked against
    // reality by someone who does not read this file.
    const caught = () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      return { spy, text: () => JSON.stringify(spy.mock.calls) };
    };

    it("4: something answered literal null — says so, not 'wrong shape'", async () => {
      // `null` is valid JSON, so res.json() resolves and every optional chain
      // yields undefined. Reported as a shape problem, it would send whoever
      // reads it after our own schema instead of the intermediary.
      const { spy, text } = caught();
      try {
        respond(null);
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });
        expect(text()).toContain("response body was null");
      } finally {
        spy.mockRestore();
      }
    });

    it("13: server sent `errors: []`, which cannot happen — named separately", async () => {
      // GraphQL says `errors` is present only when non-empty. The guard is
      // `.length`, so this used to fall through to the id check and be
      // reported as a missing id -- the wrong diagnosis for a server that
      // believed it was reporting a failure.
      const { spy, text } = caught();
      try {
        respond({ errors: [], data: { createInquiry: null } });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });
        expect(text()).toContain("empty errors array");
      } finally {
        spy.mockRestore();
      }
    });

    it("12: id present but the wrong type — reports which", async () => {
      // "absent" and "present but wrong" point at different culprits, so the
      // report names the type rather than just saying it was unusable.
      const { spy, text } = caught();
      try {
        respond({ data: { createInquiry: { id: 42 } } });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });
        expect(text()).toContain("number");
      } finally {
        spy.mockRestore();
      }
    });

    it("12: id is an empty string — not a success", async () => {
      // Truthiness would have accepted `{ id: "" }` as recorded.
      const { spy } = caught();
      try {
        respond({ data: { createInquiry: { id: "" } } });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "unknown",
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("14: BOTH an error and data — the error wins", async () => {
      // GraphQL permits partial success. Telling a buyer their inquiry was
      // recorded when the server also reported a failure is the exact defect
      // this feature was built to avoid.
      respond({
        errors: [{ message: "x", extensions: { code: "CONFLICT" } }],
        data: { createInquiry: { id: "inq_real" } },
      });
      await expect(submitInquiry(INPUT)).resolves.toEqual({
        ok: false,
        reason: "conflict",
      });
    });

    it("7: over a limit the server could not date — no invented number", async () => {
      // A hint the API never promised would be the UI lying on its behalf.
      respond({
        errors: [{ message: "x", extensions: { code: "TOO_MANY_REQUESTS" } }],
      });
      await expect(submitInquiry(INPUT)).resolves.toEqual({
        ok: false,
        reason: "rate-limited",
      });
    });

    it("6/7: an unusable hint is treated as no hint", async () => {
      // Zero, negative and non-numeric all mean "the server could not date
      // this", not "retry immediately".
      for (const retryAfterMs of [0, -1, "soon", null, NaN]) {
        respond({
          errors: [
            { message: "x", extensions: { code: "TOO_MANY_REQUESTS", retryAfterMs } },
          ],
        });
        await expect(submitInquiry(INPUT)).resolves.toEqual({
          ok: false,
          reason: "rate-limited",
        });
      }
    });

    it("does not attach a hint to a NON-throttle error", async () => {
      // A conflict does not become valid with time, so a wait is meaningless.
      respond({
        errors: [
          { message: "x", extensions: { code: "CONFLICT", retryAfterMs: 60_000 } },
        ],
      });
      await expect(submitInquiry(INPUT)).resolves.toEqual({
        ok: false,
        reason: "conflict",
      });
    });
  });

  describe("no input can break it (property)", () => {
    // THE ANSWER TO "how do we know every case is listed". The table above is
    // an enumeration someone wrote, so it is only as complete as their
    // imagination. This is the complement: generate bodies nobody enumerated
    // and assert the two properties that must hold for ALL of them.
    //
    //   1. it never rejects   the form has no catch; a rejection leaves the
    //                         button disabled in "sending" forever
    //   2. the result is a valid discriminated union, so every caller branch
    //                         is reachable and none receives a shape it
    //                         cannot handle
    //
    // Deterministic rather than random: a property test that fails only on
    // some runs is a flake, and this repo has already documented what a
    // frequently-red check does to a team's willingness to read it.
    const VALUES: unknown[] = [
      null,
      undefined,
      0,
      -1,
      NaN,
      "",
      "CONFLICT",
      true,
      [],
      {},
      { id: null },
      { id: "" },
      { id: 42 },
      { id: {} },
      [1, 2, 3],
      { __proto__: { polluted: true } },
      { constructor: { prototype: {} } },
      { extensions: null },
      { extensions: { code: {} } },
      { extensions: { code: "__proto__" } },
      { extensions: { code: "constructor" } },
      { extensions: { code: "toString" } },
      { extensions: { retryAfterMs: Infinity } },
    ];

    const bodies: unknown[] = [];
    for (const v of VALUES) {
      bodies.push(v);
      bodies.push({ data: v });
      bodies.push({ errors: v });
      bodies.push({ errors: [v] });
      bodies.push({ data: { createInquiry: v } });
      bodies.push({ errors: [v], data: { createInquiry: { id: "x" } } });
    }

    const REASONS = ["network", "rate-limited", "invalid", "conflict", "unknown"];

    it(`survives ${String(bodies.length)} adversarial bodies`, async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const body of bodies) {
          respond(body);
          const result = await submitInquiry(INPUT);

          // Never a thrown value, and never a shape the form cannot switch on.
          expect(typeof result.ok).toBe("boolean");
          if (result.ok) {
            expect(Object.keys(result)).toEqual(["ok"]);
          } else {
            expect(REASONS).toContain(result.reason);
            // A hint, when present, is always a usable positive number --
            // never NaN or Infinity leaking through to a "try again in
            // Infinity minutes".
            if ("retryAfterMs" in result && result.retryAfterMs !== undefined) {
              expect(Number.isFinite(result.retryAfterMs)).toBe(true);
              expect(result.retryAfterMs).toBeGreaterThan(0);
            }
          }
        }
      } finally {
        spy.mockRestore();
      }
    });

    it("a prototype key in the code position is not a category", async () => {
      // Indexing a lookup with wire data reads inherited keys on a bad day:
      // BUYER_SEES["toString"] is a function, which is truthy. hasOwnProperty
      // is what keeps that from becoming a category.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const code of ["__proto__", "constructor", "toString", "valueOf"]) {
          respond({ errors: [{ message: "x", extensions: { code } }] });
          await expect(submitInquiry(INPUT)).resolves.toEqual({
            ok: false,
            reason: "unknown",
          });
        }
      } finally {
        spy.mockRestore();
      }
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
