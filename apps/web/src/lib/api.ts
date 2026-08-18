import type { Product } from "@/components/product-card";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql";

// GraphQL doesn't care about whitespace/formatting, but this goes in a URL
// (GraphQL-over-GET, see fetchProductsPaged) where every character costs a
// real byte — and once percent-encoded, whitespace costs *more* per
// character than it did unencoded (each space/newline becomes %20/%0A).
// Collapsed once here at module load, not per-request, so the source stays
// readable without paying that cost on every call.
const minifyGql = (query: string) => query.replace(/\s+/g, " ").trim();

const PRODUCTS_PAGED_QUERY = minifyGql(`
  query ProductsPaged($page: Int, $pageSize: Int) {
    productsPaged(page: $page, pageSize: $pageSize) {
      page
      pageSize
      totalCount
      totalPages
      items {
        id name brand category deviceClass certifications location
        description imageUrl
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

  const res = await fetch(url, {
    method: "GET",
    headers: {
      // Apollo Server's CSRF protection requires this on GET requests —
      // proves the request went through a real fetch()/XHR (which
      // enforces a CORS preflight for non-simple requests) rather than a
      // trivial cross-site GET like an <img> tag could trigger.
      "apollo-require-preflight": "true",
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
    throw new Error(`Failed to fetch products (${res.status})`);
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
      seller: p.seller.name,
    })),
  };
}
