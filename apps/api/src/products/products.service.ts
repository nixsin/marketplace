import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { blobUrl } from '../storage/blob-config';
import {
  MANAGED_IMAGE_PREFIX,
  PRODUCT_COUNT_CACHE_SECONDS,
  PRODUCTS_MAX_OFFSET,
  PRODUCTS_MAX_PAGE_SIZE,
} from '@medinstru/config';

// Prisma's `details Json?` column accepts any valid JSON value (object,
// array, string, number, null) -- but the GraphQL field is typed
// `GraphQLJSONObject`, whose `serialize` (graphql-type-json's `ensureObject`,
// verified directly against the installed package) throws a TypeError for
// anything that isn't a plain object. Nothing currently writes `details`
// through the API (no create/update mutation exists yet -- only seed
// scripts and tests write it directly), so this isn't reachable today, but
// a future write path (e.g. bulk upload, #93) could easily produce a
// top-level array from a malformed spreadsheet column. Normalizing here,
// at the one place every read path already funnels through, means a bad
// shape degrades to "no details shown" instead of throwing and breaking
// the whole GraphQL response for that product.
export function normalizeDetails<T extends { details: unknown }>(
  product: T,
): T {
  const { details } = product;
  const isRepresentable =
    details === null ||
    details === undefined ||
    (typeof details === 'object' && !Array.isArray(details));
  return isRepresentable ? product : { ...product, details: null };
}

/**
 * Product images live under this prefix and are the ones we mirror into
 * blob storage. Anything else -- an absolute URL to a seller's own CDN, a
 * future upload path -- is returned untouched.
 */

/**
 * Resolves a stored image path to the URL a browser should fetch.
 *
 * Stored values are paths like `/products/lab-equipment.svg`, which is
 * what apps/web/public serves directly. When a blob base URL is
 * configured, the same file is served from object storage instead, so the
 * path is rewritten to point there.
 *
 * WHY THIS EXISTS AT ALL: #109 shipped the storage transport -- the port,
 * the adapters, the migration -- but nothing connected product DATA to it.
 * Uploading the files and setting NEXT_PUBLIC_BLOB_BASE_URL was therefore
 * not enough on its own: the CSP and next/image allowlists permitted the
 * blob host, but every product still pointed at the local path, so nothing
 * was ever fetched from it.
 *
 * Applied server-side rather than in the web app so every consumer gets
 * the resolved URL -- the listing, the detail page, and OpenGraph metadata
 * -- without each re-deriving the rule.
 *
 * With no blob URL configured, blobUrl() returns the same root-relative
 * path that was passed in, so output is byte-identical to before. That is
 * what makes this safe to deploy ahead of actually switching storage on,
 * and instantly revertible by unsetting one variable.
 */
export function resolveImageUrl<T extends { imageUrl: string | null }>(
  product: T,
): T {
  const { imageUrl } = product;
  if (!imageUrl?.startsWith(MANAGED_IMAGE_PREFIX)) return product;
  // Strip the leading slash: blobUrl takes a KEY, and the stored value is
  // a path. `/products/x.svg` and `products/x.svg` name the same object.
  return { ...product, imageUrl: blobUrl(imageUrl.slice(1)) };
}

/** Every read path funnels through this, so both rules apply everywhere. */
export function normalizeProduct<
  T extends { details: unknown; imageUrl: string | null },
>(product: T): T {
  return resolveImageUrl(normalizeDetails(product));
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The catalogue's total product count, memoised.
   *
   * `COUNT(*)` with no filter is the one query in the paged path that no
   * index can serve -- Postgres walks the table, while the rows beside it are
   * free on `Product(createdAt, id)`. It is also the value that changes least
   * often: the catalogue is read-only in the app today, written only by the
   * seed.
   *
   * `inFlight` is not an optimisation detail. Without it, N concurrent misses
   * each run their own COUNT -- and the sitemap fetches eight pages at once by
   * design, so a cold cache would fire eight full scans rather than one. The
   * promise is shared and cleared when it settles, so a failure is retried by
   * the next caller rather than cached.
   */
  private countCache: { value: number; expiresAt: number } | null = null;
  private inFlightCount: Promise<number> | null = null;

  private async totalProductCount(now = Date.now()): Promise<number> {
    if (this.countCache && this.countCache.expiresAt > now) {
      return this.countCache.value;
    }
    // A second caller arriving during the first one's query joins it rather
    // than starting another.
    this.inFlightCount ??= this.prisma.product
      .count()
      .then((value) => {
        this.countCache = {
          value,
          expiresAt: Date.now() + PRODUCT_COUNT_CACHE_SECONDS * 1000,
        };
        return value;
      })
      .finally(() => {
        // Cleared whether it resolved or threw. Leaving a rejected promise
        // here would serve the same failure to every later caller until the
        // process restarted.
        this.inFlightCount = null;
      });

    return this.inFlightCount;
  }

  /**
   * Drops the memoised count.
   *
   * Nothing calls this yet, deliberately -- no code path in the API creates or
   * deletes a product, so the TTL is the only invalidation there is to do.
   * It exists so that whoever adds the first write (bulk upload is the likely
   * one) has an obvious place to call, rather than discovering the staleness
   * afterwards.
   */
  invalidateProductCount(): void {
    this.countCache = null;
  }

  // Mirrors OrganizationsService.findById exactly -- NotFoundException
  // thrown here (the service), not the resolver; Apollo's Nest integration
  // converts it to a GraphQL error automatically. See products.resolver.ts's
  // own comment for why a client-supplied id lookup is safe for this model
  // specifically, unlike the removed organization(id) query.
  async findById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { seller: true },
    });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return normalizeProduct(product);
  }

  async findPage(cursor?: string, limit = 6) {
    // Same unbounded-arg problem as findPaged's pageSize, same ceiling.
    const safeLimit = Math.min(
      Math.max(1, Math.trunc(limit) || 1),
      PRODUCTS_MAX_PAGE_SIZE,
    );
    // Cursor-based, not offset-based (see TECHNICAL_PLAN.md §12B) — degrades
    // predictably as the catalog grows, unlike page-number/offset pagination.
    //
    // orderBy needs `id` as a tiebreaker, not just createdAt: rows created
    // in a tight loop (e.g. a seed script, or a burst of real inserts) can
    // land in the same millisecond — createdAt has ms precision — and
    // Postgres doesn't guarantee stable relative order for ties across
    // separate queries. Without a unique tiebreaker, cursor pagination can
    // skip or repeat a row whenever a tie's relative order shifts between
    // the page-1 and page-2 queries. Found via a genuinely flaky e2e test.
    const items = await this.prisma.product.findMany({
      take: safeLimit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { seller: true },
    });

    const hasMore = items.length > safeLimit;
    const page = hasMore ? items.slice(0, safeLimit) : items;
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return { items: page.map(normalizeProduct), nextCursor };
  }

  // Offset-based numbered pagination — see ProductsPaged model for why this
  // is a deliberate, separate query rather than replacing findPage above.
  async findPaged(page = 1, pageSize = 4) {
    const safePage = Math.max(1, page);
    // pageSize is an anonymous, public GraphQL arg that reached Prisma's
    // `take` unbounded: one request could ask for the whole catalogue, and
    // `pageSize: 0` made totalPages Infinity below (ceil(n / 0)). Clamped
    // rather than rejected, so an out-of-range value in a shared link still
    // renders a page instead of erroring.
    const safePageSize = Math.min(
      Math.max(1, Math.trunc(pageSize) || 1),
      PRODUCTS_MAX_PAGE_SIZE,
    );
    // The other half of the same problem: `page` is an anonymous public Int
    // too, and skip = (page - 1) * pageSize at a max Int is an offset of
    // 214,748,364,600 -- rows Postgres reads and DISCARDS before returning
    // anything. Bounded on the offset rather than on `page`, because the
    // legitimate page number grows with the catalogue (the sitemap walks it
    // in order), so a page cap would break sitemap generation at a size
    // nobody would connect back to this line.
    //
    // The cap is ALIGNED DOWN to a page boundary. A bare
    // Math.min(..., PRODUCTS_MAX_OFFSET) lands mid-page whenever the ceiling
    // is not divisible by pageSize: at pageSize 3 it queries offset 100000
    // while reporting page 33334, which really starts at 99999 -- skipping
    // that row and making the page number a lie about the rows returned.
    const maxSkip =
      Math.floor(PRODUCTS_MAX_OFFSET / safePageSize) * safePageSize;
    const skip = (safePage - 1) * safePageSize;

    // REJECTED, not clamped. Clamping mapped every page past the ceiling to
    // the same final page, so a sequential consumer -- the sitemap, above
    // all -- would walk off the end and receive that page's rows over and
    // over, with nothing anywhere reporting a problem. Publishing a sitemap
    // of duplicated products silently is worse than failing to publish one.
    //
    // Deliberately different from the treatment of page 0 or a negative
    // page, which ARE clamped: those are malformed requests for a page that
    // exists, and rendering the first page is friendlier than an error. This
    // is a request for a page that cannot be served at all, and answering it
    // with different rows than were asked for is a lie.
    if (skip > maxSkip) {
      throw new BadRequestException(
        `Page ${safePage} is beyond the deepest page this query can serve ` +
          `at pageSize ${safePageSize}. Use the cursor query for deep walks.`,
      );
    }
    // Equal to safePage now that unservable pages throw rather than being
    // clamped -- kept as its own name because it is what the response
    // promises, and the two must not drift apart again.
    const servedPage = Math.floor(skip / safePageSize) + 1;

    const [items, totalCount] = await Promise.all([
      this.prisma.product.findMany({
        skip,
        take: safePageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // see findPage
        include: { seller: true },
      }),
      this.totalProductCount(),
    ]);

    return {
      items: items.map(normalizeProduct),
      page: servedPage,
      pageSize: safePageSize,
      totalCount,
      // Capped at what is actually REACHABLE, not at what exists. The
      // offset bound above means pages past maxSkip cannot be served -- a
      // request for one returns the capped page instead -- so advertising
      // them would promise pages that silently resolve to the wrong rows.
      // totalCount stays truthful; only the page count is bounded, and the
      // sitemap shards off totalCount rather than this.
      //
      // Unreachable below a 100,000-product catalogue, which is far above
      // today's. The real fix past that is cursor traversal for deep walks
      // -- offset pagination cannot serve them at any bound.
      totalPages: Math.max(
        1,
        Math.min(
          Math.ceil(totalCount / safePageSize),
          Math.floor(maxSkip / safePageSize) + 1,
        ),
      ),
    };
  }
}
