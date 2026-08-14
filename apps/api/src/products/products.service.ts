import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(cursor?: string, limit = 6) {
    // Cursor-based, not offset-based (see TECHNICAL_PLAN.md §12B) — degrades
    // predictably as the catalog grows, unlike page-number/offset pagination.
    const items = await this.prisma.product.findMany({
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: { seller: true },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return { items: page, nextCursor };
  }
}
