import { Injectable } from '@nestjs/common';
import type { CacheStore } from './cache-store';

/**
 * The cache used when no `REDIS_URL` is configured.
 *
 * Every read misses and every write is discarded, so callers fall through to
 * their source of truth exactly as they would on a cold cache. That makes an
 * unconfigured environment behave like a permanently cold one rather than a
 * broken one -- local development without the Docker stack, and the API's own
 * e2e suite, both run this way.
 *
 * Reported as HEALTHY, deliberately. "No cache configured" is a valid
 * deployment, not a fault; reporting it unhealthy would make the health
 * endpoint red for every developer running the API bare and train people to
 * ignore it. A configured-but-unreachable Redis is the case that is genuinely
 * wrong, and RedisCacheStore reports that one.
 */
@Injectable()
export class NullCacheStore implements CacheStore {
  // The generics are part of the CacheStore contract; this implementation
  // simply never has a value to shape.

  get<T>(): Promise<T | null> {
    return Promise.resolve(null);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  set<T>(): Promise<void> {
    return Promise.resolve();
  }

  del(): Promise<void> {
    return Promise.resolve();
  }

  isHealthy(): boolean {
    return true;
  }
}
