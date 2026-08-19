import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return normalizeDetails(product);
  }

  async findPage(cursor?: string, limit = 6) {
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
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { seller: true },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return { items: page.map(normalizeDetails), nextCursor };
  }

  // Offset-based numbered pagination — see ProductsPaged model for why this
  // is a deliberate, separate query rather than replacing findPage above.
  async findPaged(page = 1, pageSize = 4) {
    const safePage = Math.max(1, page);
    const [items, totalCount] = await Promise.all([
      this.prisma.product.findMany({
        skip: (safePage - 1) * pageSize,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // see findPage
        include: { seller: true },
      }),
      this.prisma.product.count(),
    ]);

    return {
      items: items.map(normalizeDetails),
      page: safePage,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    };
  }
}
