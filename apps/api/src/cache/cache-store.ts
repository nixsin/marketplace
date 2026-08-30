/**
 * The cache contract, kept deliberately small.
 *
 * Two implementations sit behind it: Redis in a deployed environment, and a
 * no-op when `REDIS_URL` is unset. The interface is narrow so the no-op is
 * genuinely equivalent rather than a partial stand-in -- a cache that can only
 * be missed is a valid cache, and every caller already has to handle a miss.
 *
 * `get` returns `null` for both "not cached" and "cache unreachable", on
 * purpose. A caller that distinguished them would grow a second code path for
 * an infrastructure state it cannot do anything about; the fallback is the
 * same either way. Unreachability is reported through the health signal
 * instead, where an operator can see it.
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Whether the backing store is currently usable. For health reporting. */
  isHealthy(): boolean;
}

/** DI token. A string, since `CacheStore` is an interface and erased. */
export const CACHE_STORE = 'CACHE_STORE';

/**
 * Namespaced key builders.
 *
 * Centralised so two features cannot collide on a bare string, and so every
 * key is greppable from one place when something needs invalidating by hand.
 * The `v1` segment is a manual escape hatch: bump it to orphan every existing
 * entry at once if a value's SHAPE changes incompatibly, which is cheaper and
 * safer than trying to migrate cached JSON.
 */
export const cacheKeys = {
  /**
   * Keyed on the catalogue version, which is what makes invalidation
   * reliable: bumping the version in the writing transaction moves every
   * reader to a new key atomically, so a stale entry becomes unreachable
   * rather than needing to be deleted.
   */
  productCount: (version: bigint) => `v1:products:count:gen:${version}`,
} as const;
