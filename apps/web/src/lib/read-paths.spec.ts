import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchProduct, fetchProductsPaged } from "./api";

/**
 * Every state the two read paths can reach.
 *
 * Neither had a spec. Both trusted `res.json()` and the shape of what came
 * back, and the enumeration found states where the resulting failure was worse
 * than the one it hid -- a TypeError naming a property, carrying no
 * correlation id, reaching the error boundary looking like a bug in our
 * rendering rather than a bad response from the API.
 *
 * Named as what the VISITOR is doing, so a row can be checked against reality
 * without reading the implementation.
 */
let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // reportApiFailure writes here. Silenced so a passing run is readable, but
  // asserted on: a failure that is not reported cannot be traced.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** headers included: reportApiFailure reads the correlation id off them. */
function respond(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  });
}

function respondNotJson() {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  });
}

/** Everything reportApiFailure logged, as one searchable string. */
const reported = () => JSON.stringify(errorSpy.mock.calls);

const PRODUCT = {
  id: "p1",
  name: "X-Ray",
  brand: "MedTech",
  category: "Imaging",
  deviceClass: "C",
  hasInquiryContact: true,
  certifications: [],
  location: "Chennai",
  description: "d",
  imageUrl: null,
  updatedAt: "2026-01-01",
  seller: { name: "S", gstin: null, kycStatus: null },
  details: null,
};

describe("fetchProduct", () => {
  it("returns the product when the API answers normally", async () => {
    respond({ data: { product: PRODUCT } });
    await expect(fetchProduct("p1")).resolves.toMatchObject({ id: "p1" });
  });

  it("visitor opens a link to a product that was removed", async () => {
    // NOT_FOUND is the one error that is not a failure: the page renders its
    // own not-found, and that 404 status is what crawlers index.
    respond({ errors: [{ message: "gone", extensions: { code: "NOT_FOUND" } }] });
    await expect(fetchProduct("p1")).resolves.toBeNull();
  });

  it("API answers data.product = null, which is also 'removed'", async () => {
    respond({ data: { product: null } });
    await expect(fetchProduct("p1")).resolves.toBeNull();
  });

  it("API reports a real error — thrown AND reported", async () => {
    // Previously thrown WITHOUT being reported, so a failing product page
    // carried no correlation trace: the one situation the ids exist for.
    respond({
      errors: [{ message: "boom", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
    });
    await expect(fetchProduct("p1")).rejects.toThrow(/boom/);
    expect(reported()).toContain("boom");
    expect(reported()).toContain("client_request_id");
  });

  it("visitor is behind a proxy serving an HTML error page with a 200", async () => {
    // Previously an unreported SyntaxError from res.json().
    respondNotJson();
    await expect(fetchProduct("p1")).rejects.toThrow(/not JSON/);
    expect(reported()).toContain("client_request_id");
  });

  it("something answered a literal null body", async () => {
    // Previously "Cannot read properties of null" -- a property name instead
    // of a cause.
    respond(null);
    await expect(fetchProduct("p1")).rejects.toThrow(/was null/);
  });

  it("body has neither data nor errors", async () => {
    respond({});
    await expect(fetchProduct("p1")).rejects.toThrow(/neither data nor errors/);
  });

  it("server sent errors: [], which cannot happen", async () => {
    // Left alone this reads as success -- the worst reading, since the server
    // believed it was reporting a failure.
    respond({ errors: [] });
    await expect(fetchProduct("p1")).rejects.toThrow(/empty errors array/);
  });

  it("errors is present but not an array", async () => {
    respond({ errors: "boom" });
    await expect(fetchProduct("p1")).rejects.toThrow(/not an array/);
  });

  it("an error entry carrying no message still throws something readable", async () => {
    respond({ errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] });
    await expect(fetchProduct("p1")).rejects.toThrow(/no message/);
  });

  it("connection drops before a response", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchProduct("p1")).rejects.toThrow(/Failed to fetch/);
    expect(reported()).toContain("client_request_id");
  });

  it("edge answers a non-2xx", async () => {
    respond({}, false);
    await expect(fetchProduct("p1")).rejects.toThrow(/Failed to fetch product/);
  });

  it("the whole body is a scalar, not an object", async () => {
    // Distinct from null: the message names the type, so "something returned
    // a number" is not reported as "something returned nothing".
    respond(42);
    await expect(fetchProduct("p1")).rejects.toThrow(/was number/);
  });

  it("a product with no deviceClass renders", async () => {
    // Optional in the schema; the mapper must not turn absent into a crash.
    respond({ data: { product: { ...PRODUCT, deviceClass: null } } });
    await expect(fetchProduct("p1")).resolves.toMatchObject({
      deviceClass: undefined,
    });
  });

  it("data is present but not an object", async () => {
    // `data.product` on a string is undefined, not a throw, so this would
    // have quietly become "product not found" -- a 404 for what is actually
    // a broken response, and a 404 is what crawlers index.
    for (const data of ["nope", 42, null]) {
      respond({ data });
      await expect(fetchProduct("p1")).rejects.toThrow(/data was/);
    }
  });
});

describe("fetchProductsPaged", () => {
  const paged = (items: unknown[]) => ({
    data: {
      productsPaged: { items, page: 1, pageSize: 4, totalCount: 1, totalPages: 1 },
    },
  });

  it("returns the page when the API answers normally", async () => {
    respond(paged([PRODUCT]));
    await expect(fetchProductsPaged()).resolves.toMatchObject({
      totalCount: 1,
      items: [{ id: "p1", seller: "S" }],
    });
  });

  it("a listed product with no deviceClass renders", async () => {
    // Optional in the schema. The listing mapper must not turn absent into a
    // crash on the home page.
    respond(paged([{ ...PRODUCT, deviceClass: null }]));
    await expect(fetchProductsPaged()).resolves.toMatchObject({
      items: [{ deviceClass: undefined }],
    });
  });

  it("API reports an error — the catalogue says so instead of a TypeError", async () => {
    // THE ONE THAT MATTERED MOST. `errors` was never checked here, so a
    // GraphQL error on the home page reached `json.data.productsPaged` with
    // `data` undefined and produced "Cannot read properties of undefined",
    // naming a property rather than the outage that caused it.
    respond({ errors: [{ message: "database is down" }] });
    await expect(fetchProductsPaged()).rejects.toThrow(/database is down/);
    expect(reported()).toContain("database is down");
    expect(reported()).toContain("client_request_id");
  });

  it("connection drops before a response", async () => {
    // Previously UNGUARDED: the failure most likely to be seen by a visitor
    // was the one carrying no correlation trace at all.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchProductsPaged()).rejects.toThrow(/Failed to fetch/);
    expect(reported()).toContain("client_request_id");
  });

  it("visitor is behind a proxy serving an HTML error page with a 200", async () => {
    respondNotJson();
    await expect(fetchProductsPaged()).rejects.toThrow(/not JSON/);
  });

  it("edge answers a non-2xx", async () => {
    respond({}, false);
    await expect(fetchProductsPaged()).rejects.toThrow(/Failed to fetch products/);
    expect(reported()).toContain("client_request_id");
  });

  it("an error entry carrying no message still throws something readable", async () => {
    respond({ errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] });
    await expect(fetchProductsPaged()).rejects.toThrow(/no message/);
  });

  it("productsPaged is missing from an otherwise valid body", async () => {
    respond({ data: {} });
    await expect(fetchProductsPaged()).rejects.toThrow(/expected productsPaged/);
  });

  it("REFUSES a non-numeric totalCount, which disarms the sitemap's 404 guard", async () => {
    // The sharded sitemap route derives sitemapCount from this. NaN makes
    // `sitemapId >= sitemapCount` false for EVERY id, so the 404 guard stops
    // guarding and any shard number is served -- silently.
    respond({
      data: {
        productsPaged: {
          items: [],
          page: 1,
          pageSize: 4,
          totalCount: "many",
          totalPages: 1,
        },
      },
    });
    await expect(fetchProductsPaged()).rejects.toThrow(/totalCount was many/);
  });

  it("REFUSES a non-numeric totalPages, which truncates the sitemap", async () => {
    // loadSitemapProducts takes Math.min(totalPages, lastPage) as its loop
    // bound, so NaN ends the loop before it starts and publishes a sitemap
    // containing only the first page -- a wrong sitemap that looks complete.
    respond({
      data: {
        productsPaged: {
          items: [],
          page: 1,
          pageSize: 4,
          totalCount: 0,
          totalPages: null,
        },
      },
    });
    await expect(fetchProductsPaged()).rejects.toThrow(/totalPages was null/);
  });

  it("REFUSES a negative or infinite count", async () => {
    for (const totalCount of [-1, Infinity, NaN]) {
      respond({
        data: {
          productsPaged: {
            items: [],
            page: 1,
            pageSize: 4,
            totalCount,
            totalPages: 1,
          },
        },
      });
      await expect(fetchProductsPaged()).rejects.toThrow(/not a count/);
    }
  });

  it("items is not an array", async () => {
    // `.map` on a non-array is a TypeError; the shape is checked first.
    respond(paged("nope" as unknown as unknown[]));
    await expect(fetchProductsPaged()).rejects.toThrow(/items array/);
  });

  it("NEVER returns an empty page for a failure", async () => {
    // Load-bearing for the sitemap: an outage rendered as a successful empty
    // catalogue is exactly what must not become cacheable.
    for (const body of [null, {}, { data: {} }, { errors: [{ message: "x" }] }]) {
      respond(body);
      await expect(fetchProductsPaged()).rejects.toThrow();
    }
  });
});
