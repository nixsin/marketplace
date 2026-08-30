import { Global, Module } from '@nestjs/common';
import { CACHE_STORE, type CacheStore } from './cache-store';
import { NullCacheStore } from './null-cache.store';
import { RedisCacheStore } from './redis-cache.store';
import { CacheVersionService } from './cache-version.service';

/** Name only, never a value — this file is committed. */
export const REDIS_URL_ENV = 'REDIS_URL';

/**
 * Picks the cache implementation from the environment.
 *
 * No `REDIS_URL` yields a null cache rather than an error: an API that
 * refuses to run without a cache has turned an optional dependency into a
 * required one, and the e2e suite plus a bare local run both go that way.
 *
 * Exported and named rather than inlined in the module decorator, because a
 * factory inside a `*.module.ts` is exactly the shape that hid
 * `createBlobStore` from coverage for months — see CLAUDE.md on why nothing
 * is excluded from `collectCoverageFrom` any more.
 */
export function createCacheStore(): CacheStore {
  const url = process.env[REDIS_URL_ENV];
  return url ? new RedisCacheStore(url) : new NullCacheStore();
}

@Global()
@Module({
  providers: [
    { provide: CACHE_STORE, useFactory: createCacheStore },
    CacheVersionService,
  ],
  exports: [CACHE_STORE, CacheVersionService],
})
export class CacheModule {}

export { CACHE_STORE, type CacheStore } from './cache-store';
