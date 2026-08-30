// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { PrismaService } from './prisma.service';

/**
 * The Prisma lifecycle hooks.
 *
 * Small, and the reason they are worth pinning is that they are the only
 * thing tying the client to Nest's container: without onModuleInit the
 * first query pays connection latency, and without onModuleDestroy a test
 * run or a redeploy leaks a pool. Neither failure is visible in a unit
 * test of anything else, and both hooks are invoked by the framework
 * rather than by our code, so nothing else would ever call them.
 *
 * $connect/$disconnect are stubbed on the instance -- this must not open a
 * real connection, and the point is that the hooks delegate, not what
 * Prisma does afterwards.
 */
describe('PrismaService', () => {
  let service: PrismaService;
  let connect: jest.Mock;
  let disconnect: jest.Mock;

  beforeEach(() => {
    service = new PrismaService();
    connect = jest.fn(() => Promise.resolve(undefined));
    disconnect = jest.fn(() => Promise.resolve(undefined));
    Object.assign(service, { $connect: connect, $disconnect: disconnect });
  });

  it('connects on module init', async () => {
    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects on module destroy', async () => {
    await service.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('AWAITS the connection rather than firing and forgetting', async () => {
    // If the hook returned before $connect settled, Nest would report the
    // module ready while the pool was still opening -- and a failure would
    // surface as an unhandled rejection at some unrelated later moment
    // instead of failing startup.
    let settled = false;
    Object.assign(service, {
      $connect: async () => {
        await Promise.resolve();
        settled = true;
      },
    });

    await service.onModuleInit();

    expect(settled).toBe(true);
  });
});
