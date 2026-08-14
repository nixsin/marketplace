import type { Product } from "@/components/product-card";

// NEXT_PUBLIC_-prefixed, so this is safe to read on the client too — this
// function runs both in the initial Server Component render and in the
// browser (ProductList) for subsequent incrementally-loaded pages.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql";

const PRODUCTS_QUERY = `
  query Products($cursor: String, $limit: Int) {
    products(cursor: $cursor, limit: $limit) {
      nextCursor
      items {
        id name brand category deviceClass certifications location
        seller { name }
      }
    }
  }
`;

interface ProductsQueryResponse {
  data: {
    products: {
      nextCursor: string | null;
      items: {
        id: string;
        name: string;
        brand: string;
        category: string;
        deviceClass: "A" | "B" | "C" | "D" | null;
        certifications: string[];
        location: string;
        seller: { name: string };
      }[];
    };
  };
}

export interface ProductPage {
  items: Product[];
  nextCursor?: string;
}

export async function fetchProductPage(
  cursor?: string,
  limit = 6,
): Promise<ProductPage> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: PRODUCTS_QUERY,
      variables: { cursor, limit },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch products (${res.status})`);
  }

  const json = (await res.json()) as ProductsQueryResponse;
  const { items, nextCursor } = json.data.products;

  return {
    items: items.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      deviceClass: p.deviceClass ?? undefined,
      certifications: p.certifications,
      location: p.location,
      seller: p.seller.name,
    })),
    nextCursor: nextCursor ?? undefined,
  };
}
