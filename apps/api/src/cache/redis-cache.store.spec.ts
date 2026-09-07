import { jest } from '@jest/globals';
import { RedisCacheStore } from './redis-cache.store';

/**
 * The behaviour that makes "fails open" true rather than aspirational.
 *
 * Against an unreachable Redis, every operation must resolve quickly with a
 * miss so the caller falls through to its source of truth. The first version
 * of this class did not: node-redis QUEUES commands issued while
 * disconnected and replays them on connect, so `get()` never settled, the
 * error handling never ran, and the request hung until something upstream
 * timed out. Every e2e test failed with a 5s timeout rather than passing on
 * the null path.
 *
 * `disableOfflineQueue: true` is what makes the catch blocks reachable.
 * Asserted here against a closed port, because the failure is invisible to
 * any test that has a working Redis.
 */
describe('RedisCacheStore against an unreachable server', () => {
  // Nothing listens here. Deliberately not a hostname that needs DNS, which
  // would measure the resolver rather than the client.
  const UNREACHABLE = 'redis://127.0.0.1:6399';
  let store: RedisCacheStore;

  beforeEach(() => {
    store = new RedisCacheStore(UNREACHABLE);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
  });

  it('reports recovery ONCE, not on every operation after it', async () => {
    // The mirror of the unhealthy path, and it matters for the same reason:
    // a cache that has been down for three weeks looks identical to a cold
    // one from the outside, so the transition is the only signal an operator
    // gets. Logging it per-operation would bury it exactly as thoroughly as
    // not logging it at all.
    //
    // The 'ready' event is emitted on the client rather than waited for --
    // this suite deliberately has no reachable Redis, and the behaviour under
    // test is the transition, not the driver's connection handling.
    const client = (
      store as unknown as { client: { emit: (e: string) => void } }
    ).client;

    // Driven unhealthy first, since recovery from a healthy state is a no-op
    // by design and would pass without the branch ever running.
    await store.get('v1:anything');
    expect(store.isHealthy()).toBe(false);

    const logged: string[] = [];
    const logger = (
      store as unknown as { logger: { log: (m: string) => void } }
    ).logger;
    jest.spyOn(logger, 'log').mockImplementation((m: string) => {
      logged.push(m);
    });

    client.emit('ready');
    client.emit('ready');

    expect(store.isHealthy()).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('cache recovered');
  });

  it('caps the reconnect backoff, so a long outage still recovers in seconds', () => {
    // The policy, not just that one exists. Unbounded exponential backoff
    // means a Redis that comes back after an hour is not picked up until the
    // next step -- which for a cache that fails open is a silent, indefinite
    // fallback to the database rather than a recovery.
    //
    // Read off the constructed client, so this asserts the value the driver
    // will actually use rather than a copy of the expression.
    const strategy = (
      store as unknown as {
        client: {
          options?: { socket?: { reconnectStrategy?: (n: number) => number } };
        };
      }
    ).client.options?.socket?.reconnectStrategy;

    expect(typeof strategy).toBe('function');
    expect(strategy!(1)).toBe(100);
    expect(strategy!(10)).toBe(1_000);
    // Capped, however long the outage runs.
    expect(strategy!(50)).toBe(3_000);
    expect(strategy!(10_000)).toBe(3_000);
  });

  it('MISSES rather than hanging', async () => {
    await expect(store.get('v1:anything')).resolves.toBeNull();
  });

  it('discards a write rather than hanging', async () => {
    await expect(store.set('v1:anything', 42, 60)).resolves.toBeUndefined();
  });

  it('discards a delete rather than hanging', async () => {
    await expect(store.del('v1:anything')).resolves.toBeUndefined();
  });

  it('reports itself unhealthy, so the state is visible to an operator', async () => {
    // A cache down for three weeks looks identical to a cold one from the
    // outside. This is the signal that tells them apart.
    await store.get('v1:anything');

    expect(store.isHealthy()).toBe(false);
  });

  it('shuts down promptly instead of waiting for a connection', async () => {
    // `quit()` on a client that never connected waits for a connection that
    // is not coming. Unbounded, that hangs a rolling deploy until the
    // orchestrator SIGKILLs the pod -- and it blew the e2e afterAll hook.
    const started = Date.now();
    await store.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
