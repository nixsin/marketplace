import type { Product } from "@/components/product-card";
import type { ProductDetail } from "@/components/product-detail";
import { API_URL } from "@medinstru/config/web";
import {
  GRAPHQL_ERROR_CODES,
  type GraphqlErrorCode,
} from "@medinstru/config";
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
      description imageUrl details updatedAt hasInquiryContact
      seller { name gstin kycStatus }
    }
  }
`);

interface ProductResponse {
  data: {
    product: {
      hasInquiryContact: boolean;
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
  errors?: { message: string; extensions?: { code?: unknown } }[];
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
    // The CODE decides 404-vs-error, not the wording. This matched
    // /not found/i against the message, which made an editorial change to the
    // API's text silently turn a real "this product is gone" 404 into a
    // thrown error -- and that page's status is what crawlers index.
    if (
      json.errors.some((e) => e.extensions?.code === GRAPHQL_ERROR_CODES.notFound)
    ) {
      return null;
    }
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
    // Coerced so the type is honest, NOT as a version-compatibility
    // mechanism -- the comment here used to claim the latter and was wrong.
    //
    // The field is selected in PRODUCT_QUERY, so an API whose schema lacks it
    // rejects the WHOLE query during validation; there is no response with an
    // absent field for this to coerce. The real requirement is a deploy
    // ORDER: the API ships before the web app, or the web app queries a field
    // the server has never heard of and every product page fails.
    //
    // What the coercion does buy is a boolean rather than undefined if the
    // shape ever loosens, so `flag && <Form/>` cannot render nothing silently.
    hasInquiryContact: Boolean(p.hasInquiryContact),
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

// ---------------------------------------------------------------------------
// Product inquiries (#91)
// ---------------------------------------------------------------------------

const CREATE_INQUIRY_MUTATION = minifyGql(`
  mutation CreateInquiry($input: CreateInquiryInput!) {
    createInquiry(input: $input) { id }
  }
`);

interface InquiryInput {
  /**
   * Stable per-SUBMISSION key. Generated once when the buyer submits and
   * REUSED on every retry -- a fresh one per attempt would defeat the whole
   * mechanism, since the server deduplicates on this exact value.
   */
  idempotencyKey: string;
  productId: string;
  buyerName: string;
  buyerPhone: string;
  message: string;
}

/**
 * A CATEGORY, not raw server text.
 *
 * One fixed error message is wrong for a network failure and actively
 * misleading for a rate limit, where retrying immediately cannot succeed and
 * only adds traffic. Categories let the UI say something actionable without
 * echoing internal error strings back to a buyer.
 */
export type InquiryFailure =
  | "network"
  | "rate-limited"
  | "invalid"
  | "conflict"
  | "unknown";

type InquiryResult =
  | { ok: true }
  | { ok: false; reason: InquiryFailure; retryAfterMs?: number };

/**
 * The shape of a GraphQL error this client cares about.
 *
 * `extensions` is the GraphQL spec's own extension point, and `code` carries
 * one of the standard codes the API emits. Both are optional here because they
 * come off the wire: a broken intermediary, or an API rolled back to before
 * codes existed, must degrade rather than throw.
 */
interface GraphqlError {
  message?: unknown;
  extensions?: { code?: unknown; retryAfterMs?: unknown };
}

/** How long the server says to wait, when it says anything at all. */
export function retryAfterFrom(error: GraphqlError | undefined): number | null {
  const ms = error?.extensions?.retryAfterMs;
  // A hint is only usable if it is a real, positive number. Absent is
  // meaningfully different from zero: it means the server could not date the
  // wait, which is guidance to give none rather than to retry immediately.
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Maps a server error to a category the UI can act on.
 *
 * READS THE CODE, NOT THE PROSE. This used to match substrings of the server's
 * message, which made the wording a load-bearing API -- and it broke: the
 * conflict message once read "already sent with different details", the
 * rate-limit branch matched "already sent", and a buyer whose submission id
 * collided was told they had sent too many inquiries recently, pointing them
 * at a wait that could not help.
 *
 * The codes are the standard ones (GraphQL's `extensions.code`, with Apollo's
 * vocabulary), so an editorial change to any message is now free.
 *
 * An unrecognised or absent code yields "unknown" rather than a guess. That is
 * also the rollback path: an API deployed from before codes existed sends
 * none, and every buyer sees the generic copy instead of wrong copy.
 */
/**
 * Every code the API can send, mapped to what the buyer is told.
 *
 * A `Record` keyed on the union, NOT a switch with a default, and that is the
 * whole point: the compiler REQUIRES an entry for every member, so adding a
 * code to the shared contract breaks this build until someone decides what a
 * buyer should see. A switch would have accepted the new code silently and
 * shown "something went wrong" to every buyer who hit it.
 *
 * That makes exhaustiveness a property the compiler enforces rather than one
 * a reviewer has to notice. The three codes that map to "unknown" are
 * DECISIONS, not omissions -- none can reach this mutation, and if one ever
 * does, the generic copy is the honest answer:
 *
 *   NOT_FOUND        the product vanished between page load and submit; the
 *                    page itself handles a missing product, so reaching it
 *                    here means the catalogue changed under the buyer
 *   UNAUTHENTICATED  the mutation is deliberately anonymous (#91 story 3), so
 *                    this can only mean the API grew auth without telling us
 *   FORBIDDEN        same, one layer further in
 */
const BUYER_SEES: Record<GraphqlErrorCode, InquiryFailure> = {
  CONFLICT: "conflict",
  TOO_MANY_REQUESTS: "rate-limited",
  BAD_USER_INPUT: "invalid",
  NOT_FOUND: "unknown",
  UNAUTHENTICATED: "unknown",
  FORBIDDEN: "unknown",
};

export function categorizeInquiryError(
  error: GraphqlError | undefined,
): InquiryFailure {
  const code = error?.extensions?.code;
  // Narrowed before the lookup, because `code` came off the wire and can be
  // any JSON value -- a number, an object, absent entirely. Indexing the map
  // with an arbitrary value would read a prototype key on a bad day.
  if (typeof code !== "string") return "unknown";
  return Object.prototype.hasOwnProperty.call(BUYER_SEES, code)
    ? BUYER_SEES[code as GraphqlErrorCode]
    : // Deliberately NOT logged here: this function has no correlation ids and
      // no response, so anything it logged would be untraceable. reportUnknown
      // in the caller does it with the ids attached.
      "unknown";
}

/**
 * Makes an "unknown" failure DEBUGGABLE, which it otherwise is not.
 *
 * "Something went wrong" is the one category the buyer cannot act on and the
 * one an operator cannot diagnose -- several unrelated situations collapse
 * into it, and from a support ticket they are indistinguishable:
 *
 *   an unhandled code   the API grew a rejection this client has no copy for
 *   no code at all      an API rolled back to before codes existed
 *   a shapeless success  200 with no id, i.e. schema drift or an intermediary
 *                        rewriting the body
 *
 * Routed through reportApiFailure so each carries the SAME two correlation
 * ids every other failure here does: clientRequestId, which is present even
 * when nothing arrived, and the server's requestId read back off the
 * response. That pairing is the whole point of the correlation feature --
 * take a browser error, find the server log that explains it -- and until
 * now "unknown" was the one failure that did not participate in it.
 */
function reportUnknown(
  clientRequestId: string,
  cause: string,
  res?: Response,
): void {
  reportApiFailure("submitInquiry", clientRequestId, new Error(cause), res);
}

/**
 * A POST, unlike every other call in this file.
 *
 * The GraphQL-over-GET pattern the reads use exists so a CDN can cache them. A
 * mutation must never be cacheable, and POST is what guarantees that at every
 * layer -- the Cloudflare rules bypass non-GET outright, so this cannot be
 * edge-cached even by accident.
 *
 * credentials "omit" for the same reason as the reads: these requests are
 * anonymous by design (#91 story 3 -- a shared link must work on a cold visit
 * with no login), and sending credentials would both break CORS and quietly
 * make the endpoint authenticated.
 *
 * Returns a discriminated result rather than throwing, because every failure
 * here is something the buyer must be shown in the form they are looking at.
 * None of them should reach an error boundary and blank the page they were
 * filling in.
 *
 * ── EVERY STATE THIS CAN REACH ─────────────────────────────────────────────
 *
 * Enumerated from the decision points rather than from the cases anyone
 * happened to think of, because two were being silently collapsed: an empty
 * `errors` array fell through and was reported as a missing id, and a literal
 * `null` body was reported as a wrong SHAPE. Each row is a situation a real
 * buyer can be in, and what they see.
 *
 * | # | The buyer is...                              | They see            |
 * |---|----------------------------------------------|---------------------|
 * | 1 | on a train; the connection drops mid-send    | network             |
 * | 2 | fine, but the edge answers 502               | network             |
 * | 3 | behind a proxy serving HTML with a 200       | network             |
 * | 4 | behind something that answered literal null  | unknown (reported)  |
 * | 5 | retrying after editing their details         | conflict            |
 * | 6 | over a limit, and the server dated the wait  | "about N minutes"   |
 * | 7 | over a limit the server could not date       | vague wait copy     |
 * | 8 | typing a phone number the API rejects        | invalid             |
 * | 9 | hitting a rejection this client cannot map   | unknown (reported)  |
 * |10 | talking to an API rolled back before codes   | unknown (reported)  |
 * |11 | successful                                   | recorded            |
 * |12 | served a body with no error and no id        | unknown (reported)  |
 * |13 | served `errors: []`, which cannot happen     | unknown (reported)  |
 * |14 | served BOTH an error and data                | the error wins      |
 *
 * WHY 1-3 SHARE ONE CATEGORY while 4, 12 and 13 do not. The category is what
 * the BUYER can act on, and for all three of the first group the action is the
 * same: try again. They are still distinguishable to an operator, because each
 * reports its own cause and status through reportApiFailure. The unknown rows
 * are the opposite case -- identical to the buyer, and pointing at three
 * different culprits (an intermediary, our schema, the server's own idea of
 * what it sent), so each names itself.
 *
 * ROW 14 IS THE ONE THAT MUST NOT DRIFT. GraphQL permits partial success, so a
 * mutation can answer with both. The error wins: telling a buyer their inquiry
 * was recorded when the server also reported a failure is the exact defect
 * this whole feature was built to avoid.
 */
export async function submitInquiry(
  input: InquiryInput,
): Promise<InquiryResult> {
  const clientRequestId = newClientRequestId();

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...correlationHeaders(clientRequestId),
      },
      credentials: "omit",
      body: JSON.stringify({
        query: CREATE_INQUIRY_MUTATION,
        variables: { input },
      }),
    });
  } catch (error) {
    reportApiFailure("submitInquiry", clientRequestId, error);
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    const error = new Error(`Failed to submit inquiry (${res.status})`);
    reportApiFailure("submitInquiry", clientRequestId, error, res);
    return { ok: false, reason: "network" };
  }

  // Parsed inside a try. A 2xx whose body is empty, truncated or not JSON --
  // a proxy error page, a cut connection -- would otherwise throw past this
  // function's discriminated return, and the form has no catch, so it would
  // sit disabled in "sending" forever on an unhandled rejection.
  let payload: {
    data?: { createInquiry?: { id?: unknown } | null };
    errors?: GraphqlError[];
  } | null;
  try {
    payload = (await res.json()) as typeof payload;
  } catch (error) {
    reportApiFailure("submitInquiry", clientRequestId, error, res);
    return { ok: false, reason: "network" };
  }

  // GraphQL reports resolver failures as HTTP 200 with an errors array, so
  // res.ok above proves nothing about whether this worked.
  //
  // Optional-chained from `payload` itself: `null` is VALID JSON, so
  // res.json() resolves happily and `payload.errors` would then throw a
  // TypeError past the discriminated return.
  if (payload?.errors?.length) {
    // The message is TYPE-CHECKED, not just type-cast. `errors` comes off the
    // wire, so `{ errors: [{ message: 42 }] }` is a perfectly possible body
    // from a broken intermediary -- and categorizeInquiryError calls
    // .toLowerCase() on it, which throws past this function's discriminated
    // return into a caller that has no way to distinguish that from a
    // rejection it expected.
    const first = payload.errors[0];
    const reason = categorizeInquiryError(first);
    if (reason === "unknown") {
      // The code is named even when absent, because "none" and "one we do not
      // handle" are different problems: a rollback versus a gap in this
      // client. The message is the server's own and never echoes the buyer's
      // input, so it is safe to carry.
      const code = first?.extensions?.code;
      reportUnknown(
        clientRequestId,
        `unhandled GraphQL error code: ${
          typeof code === "string" ? code : "none"
        } — ${typeof first?.message === "string" ? first.message : "no message"}`,
        res,
      );
    }
    const retryAfterMs = retryAfterFrom(first);
    // Carried only for a throttle, and only when the server dated it. Anything
    // else would be the UI inventing a wait the API never promised.
    return retryAfterMs !== null && reason === "rate-limited"
      ? { ok: false, reason, retryAfterMs }
      : { ok: false, reason };
  }

  // The ID is checked, not merely the object's presence.
  //
  // `{ data: { createInquiry: {} } }` is truthy, and a bare truthiness test
  // reported it as a recorded inquiry -- the same defect as confirmation copy
  // claiming an outcome nothing produced, one layer lower. Nothing that lands
  // here should be shaped that way, but "should" is what makes it worth
  // checking: a schema drift or an intermediary rewriting the body is exactly
  // the case where the buyer must not be told it worked.
  // BODY WAS LITERALLY null. `null` is valid JSON, so res.json() resolves
  // happily and every optional chain below yields undefined -- meaning this
  // would otherwise be reported as "wrong shape" when the truth is "no body
  // at all". Different causes, so different messages: one points at an
  // intermediary returning nothing, the other at our own schema.
  if (payload === null || payload === undefined) {
    reportUnknown(clientRequestId, "response body was null", res);
    return { ok: false, reason: "unknown" };
  }

  // An EMPTY errors array. GraphQL says `errors` is present only when
  // non-empty, so this is malformed rather than a success -- and the check
  // above is `.length`, which would otherwise let it fall through and be
  // reported as a missing id. Named separately because it says something
  // different: the server thought it was reporting a failure.
  if (payload.errors && payload.errors.length === 0) {
    reportUnknown(clientRequestId, "response carried an empty errors array", res);
    return { ok: false, reason: "unknown" };
  }

  const id = payload.data?.createInquiry?.id;
  if (typeof id === "string" && id.length > 0) return { ok: true };

  // A 200, no errors, and no usable id. Nothing should be shaped this way,
  // which is exactly why it is worth naming: reaching here means schema drift
  // or an intermediary rewriting the body. The id's actual type is included
  // because "missing" and "present but wrong" point at different culprits.
  reportUnknown(
    clientRequestId,
    `response carried no error and no usable inquiry id (id was ${
      id === undefined ? "absent" : `${typeof id}`
    })`,
    res,
  );
  return { ok: false, reason: "unknown" };
}
