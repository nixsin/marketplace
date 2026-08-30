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

  it('AWAITS the connection, staying pending until it settles', async () => {
    // If the hook returned before $connect settled, Nest would report the
    // module ready while the pool was still opening -- and a failure would
    // surface as an unhandled rejection at some unrelated later moment
    // instead of failing startup.
    //
    // A DEFERRED promise, not `await Promise.resolve()`. An
    // already-resolved promise settles on the same microtask turn that the
    // test resumes on, so its continuation runs either way and the
    // assertion cannot tell awaiting from fire-and-forget -- it passes
    // against both implementations, which makes it worse than no test.
    let release!: () => void;
    const connected = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(service, { $connect: () => connected });

    let done = false;
    const init = service.onModuleInit().then(() => {
      done = true;
    });

    // Several turns, so nothing is merely slow to be observed.
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);

    release();
    await init;
    expect(done).toBe(true);
  });

  it('PROPAGATES a connection failure instead of swallowing it', async () => {
    // The other half of the same property, and the one with teeth: a hook
    // that did not await would leave this as an unhandled rejection while
    // reporting the module started cleanly.
    Object.assign(service, {
      $connect: () => Promise.reject(new Error('pool refused')),
    });

    await expect(service.onModuleInit()).rejects.toThrow('pool refused');
  });
});
