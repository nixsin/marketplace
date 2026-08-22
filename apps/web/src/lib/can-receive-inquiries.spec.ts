import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchProduct } from "./api";

/**
 * The capability flag has to survive the round trip from GraphQL to the type
 * the UI reads.
 *
 * Review noted the existing fixtures only ever set it to `false`, so nothing
 * exercised the available case at all — a mapper that dropped the field
 * entirely would have passed every test, and the inquiry form added in the
 * next change would simply never appear.
 */
const PRODUCT = {
  id: "seed-product-01",
  name: "Portable Digital X-Ray Machine",
  brand: "MedTech",
  category: "Diagnostic Imaging",
  deviceClass: null,
  certifications: [],
  location: "Chennai, TN",
  description: "",
  imageUrl: null,
  details: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  seller: { name: "MedTech Systems", gstin: null, kycStatus: "APPROVED" },
};

describe("fetchProduct: canReceiveInquiries", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function respondWith(canReceiveInquiries: unknown) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          data: { product: { ...PRODUCT, canReceiveInquiries } },
        }),
    });
  }

  it("carries TRUE through to the caller", async () => {
    respondWith(true);
    const product = await fetchProduct("seed-product-01");
    expect(product?.canReceiveInquiries).toBe(true);
  });

  it("carries false through", async () => {
    respondWith(false);
    const product = await fetchProduct("seed-product-01");
    expect(product?.canReceiveInquiries).toBe(false);
  });

  it("treats an absent field as NOT contactable", async () => {
    // Coerced rather than passed through: an older API that does not return
    // this field would otherwise make it undefined, and `undefined &&` renders
    // nothing — so the form would silently vanish instead of failing loudly.
    // Absent means "cannot receive", which is the safe reading.
    respondWith(undefined);
    const product = await fetchProduct("seed-product-01");
    expect(product?.canReceiveInquiries).toBe(false);
  });

  it("requests the field, or the server never sends it", async () => {
    // The mapper cannot carry what the query does not ask for.
    respondWith(true);
    await fetchProduct("seed-product-01");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain("canReceiveInquiries");
  });
});
