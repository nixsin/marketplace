import { createCacheStore, REDIS_URL_ENV } from './cache.module';
import { NullCacheStore } from './null-cache.store';
import { RedisCacheStore } from './redis-cache.store';

/**
 * The factory that decides whether this deployment has a cache.
 *
 * Tested for the reason CLAUDE.md gives about `createBlobStore`: a real
 * exported function living in a `*.module.ts` is exactly the shape that a
 * conventional coverage exclusion hides, and the branch it picks decides
 * production behaviour.
 */
describe('createCacheStore', () => {
  const saved = process.env[REDIS_URL_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[REDIS_URL_ENV];
    else process.env[REDIS_URL_ENV] = saved;
  });

  it('uses the null cache when no REDIS_URL is set', () => {
    // An API that refuses to run without a cache has turned an optional
    // dependency into a required one. A bare local run and the e2e suite both
    // go this way.
    delete process.env[REDIS_URL_ENV];

    expect(createCacheStore()).toBeInstanceOf(NullCacheStore);
  });

  it('uses Redis when one is configured', () => {
    process.env[REDIS_URL_ENV] = 'redis://localhost:6379';

    const store = createCacheStore();
    expect(store).toBeInstanceOf(RedisCacheStore);
    void (store as RedisCacheStore).onModuleDestroy();
  });
});

describe('NullCacheStore', () => {
  const store = new NullCacheStore();

  it('always misses, so callers fall through to their source of truth', async () => {
    await store.set('k', 1, 60);

    await expect(store.get('k')).resolves.toBeNull();
  });

  it('reports HEALTHY — "no cache configured" is a valid deployment', async () => {
    // Reporting unhealthy would make the health signal red for every
    // developer running the API bare, which trains people to ignore it. A
    // configured-but-unreachable Redis is the case that is genuinely wrong.
    expect(store.isHealthy()).toBe(true);
    await expect(store.del('k')).resolves.toBeUndefined();
  });
});
