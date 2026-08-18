import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
    return product;
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

    return { items: page, nextCursor };
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
      items,
      page: safePage,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    };
  }
}
