import {
  GRAPHQL_SHARED_MAX_AGE_SECONDS,
  GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS,
  graphqlCacheControl,
  isCacheableGraphqlResponse,
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

describe('isCacheableGraphqlResponse', () => {
  const ok = JSON.stringify({ data: { productsPaged: { items: [] } } });

  it('caches a successful query result', () => {
    expect(isCacheableGraphqlResponse(200, ok)).toBe(true);
  });

  it('refuses a resolver error, which GraphQL reports as HTTP 200', () => {
    // The bug this function exists for, reproduced from a real response
    // captured against the deployed API. Status alone says "success";
    // only the body says otherwise. Cached at a CDN, a transient failure
    // here is served to every visitor through that edge for s-maxage
    // plus the whole stale-while-revalidate window.
    const body = JSON.stringify({
      data: null,
      errors: [{ message: 'Product does-not-exist-abc not found' }],
    });
    expect(isCacheableGraphqlResponse(200, body)).toBe(false);
  });

  it('refuses a partial result that carries errors alongside data', () => {
    // GraphQL can return both. Caching it would pin the failed half.
    const body = JSON.stringify({
      data: { product: null },
      errors: [{ message: 'boom' }],
    });
    expect(isCacheableGraphqlResponse(200, body)).toBe(false);
  });

  it('refuses an empty errors array rather than guessing', () => {
    // The spec says omit `errors` when there are none, so its presence
    // already means something happened. Fail closed instead of deciding
    // that an empty array is equivalent to absence.
    const body = JSON.stringify({ data: { ok: 1 }, errors: [] });
    expect(isCacheableGraphqlResponse(200, body)).toBe(false);
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503])(
    'refuses HTTP %i whatever the body says',
    (status) => {
      // Apollo answers CSRF blocks and validation errors with 4xx while
      // still emitting a JSON body; a 5xx may come from anywhere.
      expect(isCacheableGraphqlResponse(status, ok)).toBe(false);
    },
  );

  it('reads a Buffer body, which is what Express actually passes', () => {
    // res.send serialises to a Buffer, so a string-only implementation
    // would fail closed on every real response and silently disable
    // edge caching altogether -- the opposite failure, equally invisible.
    expect(isCacheableGraphqlResponse(200, Buffer.from(ok, 'utf8'))).toBe(true);
  });

  it.each([
    ['a truncated body', '{"data":{"a":1}'],
    ['an empty body', ''],
    ['plain text', 'Internal Server Error'],
  ])('refuses %s', (_label, body) => {
    expect(isCacheableGraphqlResponse(200, body)).toBe(false);
  });

  it.each([
    ['no chunk at all', undefined],
    ['a null chunk', null],
    ['an end(callback) function', () => {}],
    ['a number', 42],
  ])('refuses %s', (_label, body) => {
    expect(isCacheableGraphqlResponse(200, body)).toBe(false);
  });

  it.each([
    ['a JSON array', '[{"data":{}}]'],
    ['a bare string', '"hello"'],
    ['a bare null', 'null'],
  ])('refuses %s, which is not a GraphQL response object', (_label, body) => {
    expect(isCacheableGraphqlResponse(200, body)).toBe(false);
  });

  it('refuses an object with no data key', () => {
    // A proxy or gateway error page that happens to be JSON must not be
    // cached as though it were a result.
    expect(isCacheableGraphqlResponse(200, '{"message":"Bad Gateway"}')).toBe(
      false,
    );
  });

  it('caches a null data field, which is a legitimate result', () => {
    // `{"data":{"product":null}}` with no errors is a real answer -- the
    // product genuinely does not exist and the schema allows null. The
    // errors check must not be so broad that it swallows this.
    expect(isCacheableGraphqlResponse(200, '{"data":{"product":null}}')).toBe(
      true,
    );
  });
});
