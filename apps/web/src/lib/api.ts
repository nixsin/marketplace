import type { Product } from "@/components/product-card";
import type { ProductDetail } from "@/components/product-detail";
import { API_URL } from "@medinstru/config";
import { correlationHeaders, newClientRequestId } from "./correlation";
import { reportApiFailure } from "./report-api-failure";

// GraphQL doesn't care about whitespace/formatting, but this goes in a URL
// (GraphQL-over-GET, see fetchProductsPaged) where every character costs a
// real byte — and once percent-encoded, whitespace costs *more* per
// character than it did unencoded (each space/newline becomes %20/%0A).
// Collapsed once here at module load, not per-request, so the source stays
// readable without paying that cost on every call.
const minifyGql = (query: string) => query.replace(/\s+/g, " ").trim();

// Exported solely so a test can compare it against public/sw.js's
// allowlist. The service worker is a static file the browser loads
// directly -- it cannot import anything -- so this exact string is
// duplicated there by necessity, and the only way to keep the two honest
// is to assert they match. See apps/web/test/sw-query-sync.spec.ts.
export const PRODUCTS_PAGED_QUERY = minifyGql(`
  query ProductsPaged($page: Int, $pageSize: Int) {
    productsPaged(page: $page, pageSize: $pageSize) {
      page
      pageSize
      totalCount
      totalPages
      items {
        id name brand category deviceClass certifications location
        description imageUrl updatedAt
        seller { name }
      }
    }
  }
`);

interface ProductsPagedResponse {
  data: {
    productsPaged: {
      page: number;
      pageSize: number;
      totalCount: number;
      totalPages: number;
      items: {
        id: string;
        name: string;
        brand: string;
        category: string;
        deviceClass: "A" | "B" | "C" | "D" | null;
        certifications: string[];
        location: string;
        description: string;
        imageUrl: string | null;
        updatedAt: string;
        seller: { name: string };
      }[];
    };
  };
}

export interface ProductsPaged {
  items: Product[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

const PRODUCT_QUERY = minifyGql(`
  query Product($id: ID!) {
    product(id: $id) {
      id name brand category deviceClass certifications location
      description imageUrl details updatedAt
      seller { name gstin kycStatus }
    }
  }
`);

interface ProductResponse {
  data: {
    product: {
      id: string;
      name: string;
      brand: string;
      category: string;
      deviceClass: "A" | "B" | "C" | "D" | null;
      certifications: string[];
      location: string;
      description: string;
      imageUrl: string | null;
      details: Record<string, unknown> | null;
      updatedAt: string;
      seller: {
        name: string;
        gstin: string | null;
        kycStatus: "PENDING" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";
      };
    } | null;
  };
  errors?: { message: string }[];
}

// Distinct from fetchProductsPaged's Product return type -- the list stays
// lean (see product-card.tsx's Product interface); this fetches the
// heavier detail shape only when a single product view is actually
// opened. Same GraphQL-over-GET pattern (GET, CSRF preflight header,
// credentials: "omit") for the same reasons documented on
// fetchProductsPaged below.
//
// Returns null specifically for a matched "not found" GraphQL error (the
// backend's NotFoundException, see products.service.ts) -- the caller
// (the product-details page) turns that into Next's notFound(). Any other
// error (network failure, a different GraphQL error) throws instead, to
// be caught by the route's error.tsx boundary -- these are two genuinely
// different situations for the UI, not the same "something went wrong".
export async function fetchProduct(id: string): Promise<ProductDetail | null> {
  const url = new URL(API_URL);
  url.searchParams.set("query", PRODUCT_QUERY);
  url.searchParams.set("variables", JSON.stringify({ id }));

  // Generated BEFORE the call, not read from the response: if this request
  // never completes there is no response to read a server id from, and a
  // request that vanished is exactly the one worth being able to trace.
  const clientRequestId = newClientRequestId();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "apollo-require-preflight": "true",
        // Correlation. No extra round trip: apollo-require-preflight above
        // already makes this a preflighted cross-origin request, so these
        // ride along on a preflight that was happening regardless.
        ...correlationHeaders(clientRequestId),
      },
      credentials: "omit",
    });
  } catch (error) {
    // No response at all -- timeout, DNS, connection refused, CORS block.
    // The client id is the only identifier that exists here, and whether
    // a server log carries it answers the first question worth asking:
    // did the request arrive?
    reportApiFailure("fetchProduct", clientRequestId, error);
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`Failed to fetch product (${res.status})`);
    reportApiFailure("fetchProduct", clientRequestId, error, res);
    throw error;
  }

  const json = (await res.json()) as ProductResponse;

  if (json.errors) {
    if (json.errors.some((e) => /not found/i.test(e.message))) return null;
    throw new Error(json.errors[0]?.message ?? "GraphQL error");
  }

  const p = json.data.product;
  if (!p) return null;

  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    deviceClass: p.deviceClass ?? undefined,
    certifications: p.certifications,
    location: p.location,
    description: p.description,
    imageUrl: p.imageUrl ?? undefined,
    details: p.details ?? undefined,
    updatedAt: p.updatedAt,
    seller: {
      name: p.seller.name,
      gstin: p.seller.gstin ?? undefined,
      kycStatus: p.seller.kycStatus,
    },
  };
}

export async function fetchProductsPaged(
  page = 1,
  pageSize = 4,
): Promise<ProductsPaged> {
  // GET, not POST: this is a read-only, cacheable query, and only GET
  // responses can be cached/conditionally-revalidated by the browser (or
  // a CDN later) — POST is never cacheable by HTTP spec regardless of
  // headers. Query + variables go in the URL, GraphQL-over-GET per the
  // GraphQL-over-HTTP spec (also how GitHub's and Shopify's GraphQL APIs
  // support CDN caching for reads).
  const url = new URL(API_URL);
  url.searchParams.set("query", PRODUCTS_PAGED_QUERY);
  url.searchParams.set("variables", JSON.stringify({ page, pageSize }));

  // See fetchProduct: generated up front so a request that never returns
  // can still be correlated with the server log, or shown to have never
  // arrived at all.
  const clientRequestId = newClientRequestId();

  const res = await fetch(url, {
    method: "GET",
    headers: {
      // Apollo Server's CSRF protection requires this on GET requests —
      // proves the request went through a real fetch()/XHR (which
      // enforces a CORS preflight for non-simple requests) rather than a
      // trivial cross-site GET like an <img> tag could trigger.
      "apollo-require-preflight": "true",
      // Correlation. No extra round trip: apollo-require-preflight above
      // already makes this a preflighted cross-origin request, so these
      // ride along on a preflight that was happening regardless.
      ...correlationHeaders(clientRequestId),
    },
    // This read is meant to be public — explicitly never send cookies,
    // regardless of same-origin/cross-origin. Also the positive signal
    // public/sw.js's cache-safety check keys off of: only a request that
    // itself declares "no credentials" is eligible for the service
    // worker's public-GraphQL cache, rather than the SW trying to infer
    // safety by checking for the absence of specific credential headers
    // after the fact.
    credentials: "omit",
  });

  if (!res.ok) {
    const error = new Error(`Failed to fetch products (${res.status})`);
    reportApiFailure("fetchProductsPaged", clientRequestId, error, res);
    throw error;
  }

  const json = (await res.json()) as ProductsPagedResponse;
  const { items, ...meta } = json.data.productsPaged;

  return {
    ...meta,
    items: items.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      deviceClass: p.deviceClass ?? undefined,
      certifications: p.certifications,
      location: p.location,
      description: p.description,
      imageUrl: p.imageUrl ?? undefined,
      updatedAt: p.updatedAt,
      seller: p.seller.name,
    })),
  };
}
