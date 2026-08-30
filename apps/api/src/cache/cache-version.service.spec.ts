import { jest } from '@jest/globals';
import { CacheVersionService } from './cache-version.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The version that makes invalidation reliable.
 *
 * The property worth pinning is not that a number goes up -- it is that the
 * bump runs on the caller's TRANSACTION CLIENT. Bumping on the service's own
 * Prisma instance instead would commit separately from the write and
 * reintroduce exactly the window this design exists to close: a crash between
 * the two leaves a committed change no reader notices until the TTL expires.
 */
describe('CacheVersionService', () => {
  let prisma: { cacheVersion: { upsert: jest.Mock } };
  let service: CacheVersionService;

  beforeEach(() => {
    prisma = { cacheVersion: { upsert: jest.fn() } };
    service = new CacheVersionService(prisma as unknown as PrismaService);
  });

  it('returns the current version', async () => {
    prisma.cacheVersion.upsert.mockResolvedValue({ version: 41n });

    await expect(service.current()).resolves.toBe(41n);
  });

  it('creates the row on first use rather than failing', async () => {
    // A fresh database, a restored dump and a truncated test database all
    // reach here. None of them should 500 because a bookkeeping row is absent.
    prisma.cacheVersion.upsert.mockResolvedValue({ version: 0n });

    await service.current();

    expect(prisma.cacheVersion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, create: { id: 1 } }),
    );
  });

  it('bumps on the CALLER’S transaction client, not its own Prisma', async () => {
    // The entire guarantee. If the bump used `this.prisma`, it would commit
    // separately from the write it is supposed to be atomic with.
    const tx = { cacheVersion: { upsert: jest.fn() } };

    await service.bump(tx as unknown as PrismaService);

    expect(tx.cacheVersion.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.cacheVersion.upsert).not.toHaveBeenCalled();
  });

  it('increments rather than writing an absolute value', async () => {
    // Two concurrent writers must both move it. Setting a computed value
    // would let one clobber the other and leave a reader addressing a key
    // that a committed change already invalidated.
    const tx = { cacheVersion: { upsert: jest.fn() } };

    await service.bump(tx as unknown as PrismaService);

    expect(tx.cacheVersion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { version: { increment: 1n } } }),
    );
  });
});
