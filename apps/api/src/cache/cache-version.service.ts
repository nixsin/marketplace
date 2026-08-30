import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The single row. Fixed id, because there is exactly one catalogue. */
const ROW_ID = 1;

/**
 * The catalogue's cache version — the thing that makes invalidation reliable.
 *
 * Read on every cached lookup and embedded in the cache key, so a reader on
 * version 42 cannot address an entry written under 41. Bumped inside the
 * transaction that changes the catalogue, which is what removes the window
 * delete-on-write cannot close: if a process dies between COMMIT and DEL, a
 * deleted-based scheme leaves a stale entry for its whole TTL and nothing
 * knows the invalidation was lost. Here a lost bump is impossible, because
 * the bump IS part of the write.
 *
 * The cost is one extra query per uncached read: a primary-key lookup against
 * a one-row table, versus the `COUNT(*)` full scan it protects. That cost is
 * flat as the catalogue grows, which is the whole point -- counting is not.
 */
@Injectable()
export class CacheVersionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The current version, creating the row on first use.
   *
   * `upsert` rather than a migration-time seed: a fresh database, a restored
   * dump and a test database that truncated everything all reach here, and
   * none of them should 500 because a bookkeeping row is absent. Zero is a
   * perfectly good starting version.
   */
  async current(): Promise<bigint> {
    const row = await this.prisma.cacheVersion.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID },
      update: {},
      select: { version: true },
    });
    return row.version;
  }

  /**
   * Bumps the version. **Call this inside the transaction that writes.**
   *
   * Passing the transaction client is not optional decoration -- it is the
   * entire guarantee. Called on `this.prisma` instead, the bump commits
   * separately from the write and reintroduces exactly the gap this design
   * exists to close: a crash between the two leaves a committed change that
   * no reader will notice until the TTL expires.
   *
   *     await prisma.$transaction(async (tx) => {
   *       await tx.product.create({ data });
   *       await cacheVersion.bump(tx);
   *     });
   */
  async bump(tx: Pick<PrismaService, 'cacheVersion'>): Promise<void> {
    await tx.cacheVersion.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, version: 1n },
      update: { version: { increment: 1n } },
    });
  }
}
