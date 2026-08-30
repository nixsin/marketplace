// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import {
  ProductsService,
  normalizeDetails,
  resolveImageUrl,
  normalizeProduct,
} from './products.service';
import { PrismaService } from '../prisma/prisma.service';

function makeProduct(id: string) {
  return { id, name: `Product ${id}`, createdAt: new Date() };
}

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: {
    product: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      product: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    };
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

    it('nulls out a details value that would crash GraphQLJSONObject serialization', async () => {
      // A top-level array is valid JSON (Prisma's `Json?` column accepts
      // it) but graphql-type-json's GraphQLJSONObject.serialize throws a
      // TypeError on anything that isn't a plain object -- verified
      // directly against the installed package before writing this guard.
      const product = { ...makeProduct('p1'), details: ['a', 'b'] };
      prisma.product.findUnique.mockResolvedValue(product);

      const result = await service.findById('p1');

      expect(result.details).toBeNull();
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

  describe('findPaged', () => {
    // Offset pagination for the numbered catalogue -- the app's entry page,
    // and untested until now. Every assertion below is about a value the
    // page renders directly, so a regression here is visible to every
    // visitor rather than to a later query.

    it('defaults to the first page and a page size of 4', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const result = await service.findPaged();

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 4 }),
      );
      expect(result).toMatchObject({ page: 1, pageSize: 4 });
    });

    it('computes skip from the requested page', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findPaged(3, 10);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it.each([0, -1, -999])('CLAMPS page %p up to 1', async (page) => {
      // A negative page would compute a negative `skip`, which Prisma
      // rejects outright -- so an out-of-range ?page= in a shared link
      // would 500 the catalogue rather than showing its first page.
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const result = await service.findPaged(page, 4);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0 }),
      );
      expect(result.page).toBe(1);
    });

    it('orders by the exact columns the catalogue index covers', async () => {
      // createdAt DESC then id DESC -- the same ordering findPage uses and
      // the pair the Product_createdAt_id_idx index exists to serve.
      // Changing it here silently drops the index and reintroduces a
      // sequential scan on the busiest query in the app.
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findPaged(1, 4);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: { seller: true },
        }),
      );
    });

    it('reports ONE page for an empty catalogue, never zero', async () => {
      // ceil(0/4) is 0, and a pager rendering "page 1 of 0" is a bug the
      // Math.max exists to prevent.
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const result = await service.findPaged(1, 4);

      expect(result).toMatchObject({ totalCount: 0, totalPages: 1 });
    });

    it('rounds a partial last page UP', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(9);

      const result = await service.findPaged(1, 4);

      expect(result.totalPages).toBe(3);
    });

    it('normalizes every item it returns', async () => {
      // The page renders these directly, so an un-normalized row reaches
      // the browser as-is.
      prisma.product.findMany.mockResolvedValue([makeProduct('p1')]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.findPaged(1, 4);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: 'p1' });
    });
  });
});

describe('normalizeDetails', () => {
  it('passes through a plain object unchanged (same reference)', () => {
    const product = { details: { probeType: 'convex' } };
    expect(normalizeDetails(product)).toBe(product);
  });

  it('passes through null and undefined unchanged', () => {
    expect(normalizeDetails({ details: null }).details).toBeNull();
    expect(normalizeDetails({ details: undefined }).details).toBeUndefined();
  });

  it('nulls out a top-level array', () => {
    expect(normalizeDetails({ details: ['a', 'b'] }).details).toBeNull();
  });

  it('nulls out a top-level primitive', () => {
    expect(normalizeDetails({ details: 'not an object' }).details).toBeNull();
    expect(normalizeDetails({ details: 42 }).details).toBeNull();
  });

  it('preserves every other field when normalizing an unrepresentable value', () => {
    const product = { id: 'p1', name: 'Widget', details: ['bad'] };
    expect(normalizeDetails(product)).toEqual({
      id: 'p1',
      name: 'Widget',
      details: null,
    });
  });
});

/**
 * Saves and restores the blob env vars around each test.
 *
 * Two separate problems this fixes, both real: a test asserting the
 * "not configured" behaviour is silently invalid if the surrounding
 * environment happens to have one of these set, and deleting them
 * unconditionally afterwards mutates global state for whatever runs next
 * -- a test that quietly changes its neighbours' environment is worse
 * than one that merely fails.
 */
function useIsolatedBlobEnv() {
  const KEYS = ['NEXT_PUBLIC_BLOB_BASE_URL', 'BLOB_PUBLIC_BASE_URL'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    // Establish the precondition rather than assume it.
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe('resolveImageUrl', () => {
  const withImage = (imageUrl: string | null) => ({ imageUrl, details: null });

  useIsolatedBlobEnv();

  it('leaves the path untouched when no blob storage is configured', () => {
    // The property that makes this safe to deploy before switching storage
    // on: output is byte-identical to before, and unsetting one variable
    // reverts it instantly.
    expect(
      resolveImageUrl(withImage('/products/lab-equipment.svg')).imageUrl,
    ).toBe('/products/lab-equipment.svg');
  });

  it('points a managed image at blob storage once configured', () => {
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = 'https://images.laxair.shop';
    expect(
      resolveImageUrl(withImage('/products/lab-equipment.svg')).imageUrl,
    ).toBe('https://images.laxair.shop/products/lab-equipment.svg');
  });

  it('leaves an absolute URL alone', () => {
    // A seller's own CDN, or an already-resolved URL. Rewriting it would
    // point at an object we never stored.
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = 'https://images.laxair.shop';
    expect(
      resolveImageUrl(withImage('https://cdn.example/x.jpg')).imageUrl,
    ).toBe('https://cdn.example/x.jpg');
  });

  it('leaves an unmanaged path alone', () => {
    // Only /products/ is mirrored into storage. A future upload path has
    // no object there yet, and rewriting it would 404.
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = 'https://images.laxair.shop';
    expect(
      resolveImageUrl(withImage('/uploads/seller-1/photo.jpg')).imageUrl,
    ).toBe('/uploads/seller-1/photo.jpg');
  });

  it('handles a product with no image', () => {
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = 'https://images.laxair.shop';
    expect(resolveImageUrl(withImage(null)).imageUrl).toBeNull();
  });

  it('does not mutate the product it was given', () => {
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = 'https://images.laxair.shop';
    const original = withImage('/products/x.svg');
    resolveImageUrl(original);
    expect(original.imageUrl).toBe('/products/x.svg');
  });
});

describe('normalizeProduct', () => {
  useIsolatedBlobEnv();

  it('applies both rules, so every read path gets both', () => {
    process.env.NEXT_PUBLIC_BLOB_BASE_URL = 'https://images.laxair.shop';
    const result = normalizeProduct({
      imageUrl: '/products/x.svg',
      // An array is not representable as GraphQLJSONObject and must
      // degrade to null rather than throw.
      details: ['not', 'an', 'object'],
    });
    expect(result.imageUrl).toBe('https://images.laxair.shop/products/x.svg');
    expect(result.details).toBeNull();
  });
});
