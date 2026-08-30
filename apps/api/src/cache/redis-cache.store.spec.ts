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
