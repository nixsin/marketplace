import {
  GRAPHQL_SHARED_MAX_AGE_SECONDS,
  GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS,
  cachePolicyFor,
  isCacheableGraphqlResponse,
} from './graphql-cache';

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

describe('cachePolicyFor', () => {
  const body = (data: unknown) => JSON.stringify({ data });

  it('never lets a LISTING be served stale', () => {
    // A listing is how a buyer discovers what exists, so showing a
    // withdrawn item -- or missing one just added -- is worse than the
    // revalidation round trip it costs.
    for (const field of ['productsPaged', 'products']) {
      const value = cachePolicyFor(body({ [field]: {} }));
      expect(value).toContain('must-revalidate');
      expect(value).not.toContain('stale-while-revalidate');
    }
  });

  it('lets a product DETAIL be served stale while it refreshes', () => {
    const value = cachePolicyFor(body({ product: { id: 'x' } }));
    expect(value).toContain('stale-while-revalidate');
    expect(value).not.toContain('must-revalidate');
  });

  it('takes the STRICT policy when one request selects both', () => {
    // One header governs the whole response, so a request selecting a
    // detail alongside a listing cannot be allowed to serve the listing
    // stale. Every field must tolerate staleness, not merely one.
    const value = cachePolicyFor(
      body({ product: { id: 'x' }, productsPaged: {} }),
    );
    expect(value).toContain('must-revalidate');
    expect(value).not.toContain('stale-while-revalidate');
  });

  it('fails CLOSED for anything it does not recognise', () => {
    // A new query silently inheriting permission to serve stale data is
    // the failure being designed out. Guessing the other way costs one
    // revalidation.
    // Jest's expect takes no message argument (that is Vitest's API, and
    // apps/api is Jest) -- so the shape under test goes in the assertion
    // itself, which also makes a failure name the culprit rather than
    // just the loop.
    for (const data of [{ somethingNew: 1 }, {}, null]) {
      expect({ data, policy: cachePolicyFor(body(data)) }).toEqual({
        data,
        policy: expect.stringContaining('must-revalidate'),
      });
    }
  });

  it('keys on the RESOLVED field, not the caller-supplied operation name', () => {
    // An operation name is caller-controlled -- a request can name
    // anything "ProductsPaged" -- and this repo has already been bitten by
    // trusting one (public/sw.js's history). `data`'s keys are what the
    // server actually executed, so they cannot be spoofed into selecting
    // a weaker policy. Here the name says listing while the resolved
    // field is a detail: the RESOLVED field must win.
    const value = cachePolicyFor(
      JSON.stringify({
        data: { product: { id: 'x' } },
        operationName: 'ProductsPaged',
      }),
    );
    expect(value).toContain('stale-while-revalidate');
  });

  it('returns a policy rather than throwing on an unparseable body', () => {
    // Unreachable in practice -- isCacheableGraphqlResponse has already
    // parsed this exact body -- but a header choice throwing inside
    // res.send would take the whole response with it.
    expect(() => cachePolicyFor('{not json')).not.toThrow();
    expect(cachePolicyFor('{not json')).toContain('must-revalidate');
  });

  it('accepts a Buffer body, which is what Express actually passes', () => {
    const value = cachePolicyFor(
      Buffer.from(body({ product: { id: 'x' } }), 'utf8'),
    );
    expect(value).toContain('stale-while-revalidate');
  });
});

describe('cache policy TTLs', () => {
  // The removed graphqlCacheControl block covered these, and the values
  // still drive both policies through cachePolicyFor. Asserted against
  // the exported constants rather than literals so tuning one actually
  // moves the header -- a literal here would let the two drift while
  // both looked tested.
  it('uses the shared max-age on both policies', () => {
    const listing = cachePolicyFor(
      JSON.stringify({ data: { productsPaged: {} } }),
    );
    const detail = cachePolicyFor(
      JSON.stringify({ data: { product: { id: 'x' } } }),
    );
    for (const value of [listing, detail]) {
      expect(value).toContain(`s-maxage=${GRAPHQL_SHARED_MAX_AGE_SECONDS}`);
      expect(value).toContain(`max-age=${GRAPHQL_SHARED_MAX_AGE_SECONDS}`);
    }
  });

  it('bounds the stale window on the detail policy only', () => {
    // Longer than the fresh window on purpose: past s-maxage the data is
    // stale but still far better than a spinner, and the refresh happens
    // off the critical path. Bounded because there is no invalidation
    // path yet, so it doubles as worst-case staleness after a seller edit.
    expect(GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS).toBeGreaterThan(
      GRAPHQL_SHARED_MAX_AGE_SECONDS,
    );
    expect(
      cachePolicyFor(JSON.stringify({ data: { product: { id: 'x' } } })),
    ).toContain(
      `stale-while-revalidate=${GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS}`,
    );
    expect(
      cachePolicyFor(JSON.stringify({ data: { productsPaged: {} } })),
    ).not.toContain('stale-while-revalidate');
  });
});
