import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';

function makeProduct(id: string) {
  return { id, name: `Product ${id}`, createdAt: new Date() };
}

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: {
    product: { findMany: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = { product: { findMany: jest.fn(), findUnique: jest.fn() } };
    service = new ProductsService(prisma as unknown as PrismaService);
  });

  describe('findById', () => {
    it('returns the product with the seller relation included when found', async () => {
      const product = makeProduct('p1');
      prisma.product.findUnique.mockResolvedValue(product);

      const result = await service.findById('p1');

      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: 'p1' },
        include: { seller: true },
      });
      expect(result).toBe(product);
    });

    it('throws NotFoundException when no product matches the id', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('defaults to a page size of 6, ordered newest first, with seller included', async () => {
    prisma.product.findMany.mockResolvedValue([]);

    await service.findPage();

    expect(prisma.product.findMany).toHaveBeenCalledWith({
      take: 7, // limit + 1, the lookahead that detects "is there a next page"
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { seller: true },
    });
  });

  it('respects a custom limit', async () => {
    prisma.product.findMany.mockResolvedValue([]);

    await service.findPage(undefined, 3);

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 4 }),
    );
  });

  it('passes cursor + skip:1 when a cursor is given (skips the cursor row itself)', async () => {
    prisma.product.findMany.mockResolvedValue([]);

    await service.findPage('product_5', 6);

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'product_5' },
        skip: 1,
      }),
    );
  });

  it('omits cursor/skip entirely on the first page', async () => {
    prisma.product.findMany.mockResolvedValue([]);

    await service.findPage();

    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call).not.toHaveProperty('cursor');
    expect(call).not.toHaveProperty('skip');
  });

  it('returns nextCursor = last item id when more pages remain', async () => {
    // limit 3, but findMany returns 4 (limit + 1) — the lookahead row proves more exist
    prisma.product.findMany.mockResolvedValue([
      makeProduct('a'),
      makeProduct('b'),
      makeProduct('c'),
      makeProduct('d'), // the lookahead row, should be dropped from the result
    ]);

    const result = await service.findPage(undefined, 3);

    expect(result.items).toHaveLength(3);
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(result.nextCursor).toBe('c'); // last item actually returned, not 'd'
  });

  it('returns nextCursor = undefined on the last page (fewer results than limit+1)', async () => {
    prisma.product.findMany.mockResolvedValue([
      makeProduct('a'),
      makeProduct('b'),
    ]);

    const result = await service.findPage(undefined, 6);

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns nextCursor = undefined when the result exactly fills the page (no lookahead row)', async () => {
    prisma.product.findMany.mockResolvedValue([
      makeProduct('a'),
      makeProduct('b'),
      makeProduct('c'),
    ]);

    const result = await service.findPage(undefined, 3);

    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns an empty page cleanly when there are no products', async () => {
    prisma.product.findMany.mockResolvedValue([]);

    const result = await service.findPage();

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});
