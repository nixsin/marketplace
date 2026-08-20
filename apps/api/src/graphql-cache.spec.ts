import {
  GRAPHQL_SHARED_MAX_AGE_SECONDS,
  GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS,
  graphqlCacheControl,
} from './graphql-cache';

describe('graphqlCacheControl', () => {
  it('keeps the browser revalidating', () => {
    // max-age=0 is for the PRIVATE cache. A user reloading must never be
    // stuck with a stale catalogue they cannot refresh.
    expect(graphqlCacheControl()).toContain('max-age=0');
    expect(graphqlCacheControl()).toContain('must-revalidate');
  });

  it('lets shared caches serve without a round trip', () => {
    // s-maxage applies to CDNs only and overrides max-age for them --
    // this is the directive that removes the trans-Pacific hop.
    expect(graphqlCacheControl()).toContain(
      `s-maxage=${GRAPHQL_SHARED_MAX_AGE_SECONDS}`,
    );
  });

  it('serves stale instantly while refreshing behind it', () => {
    // The half that works TODAY: browsers honour SWR, so a repeat
    // navigation renders from cache instead of blocking on the network,
    // with no CDN involved.
    expect(graphqlCacheControl()).toContain(
      `stale-while-revalidate=${GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS}`,
    );
  });

  it('allows a longer stale window than the fresh one', () => {
    // Past s-maxage the data is stale but still far better than a
    // spinner, and the refresh is off the critical path. If these ever
    // invert, SWR stops doing anything.
    expect(GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS).toBeGreaterThan(
      GRAPHQL_SHARED_MAX_AGE_SECONDS,
    );
  });

  it('bounds staleness, since there is no invalidation path yet', () => {
    // Nothing purges the cache when a seller edits a listing, so
    // s-maxage doubles as the worst-case staleness they would see.
    // Raise it only once an invalidation hook exists.
    expect(GRAPHQL_SHARED_MAX_AGE_SECONDS).toBeLessThanOrEqual(300);
  });

  it('is publicly cacheable', () => {
    // Product data is a public catalogue. `private` would disable shared
    // caching entirely and silently undo the point of this header.
    expect(graphqlCacheControl()).toMatch(/^public,/);
  });

  it('accepts overrides for testing and future tuning', () => {
    expect(graphqlCacheControl(30, 120)).toContain('s-maxage=30');
    expect(graphqlCacheControl(30, 120)).toContain(
      'stale-while-revalidate=120',
    );
  });
});
