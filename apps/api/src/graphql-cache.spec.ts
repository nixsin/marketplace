import {
  GRAPHQL_SHARED_MAX_AGE_SECONDS,
  GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS,
  cachePolicyFor,
  isCacheableGraphqlResponse,
  rootFieldNames,
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

describe('rootFieldNames', () => {
  const field = (name: string) => ({ kind: 'Field', name: { value: name } });

  it('reads the SCHEMA field, never the alias', () => {
    // THE test, and the bug it pins shipped in an earlier version of this
    // file. An alias becomes the RESPONSE key, so reading the serialised
    // body let `{ product: productsPaged(...) }` select the stale-tolerant
    // policy for a listing -- and the reverse aliased a real detail into
    // the strict one. The AST keeps `name` and `alias` as separate nodes,
    // so an alias cannot change the answer. This node carries one that
    // claims otherwise.
    const aliased = {
      kind: 'Field',
      alias: { value: 'product' },
      name: { value: 'productsPaged' },
    };
    expect(rootFieldNames([aliased])).toEqual(['productsPaged']);
  });

  it('returns every root field, in order', () => {
    expect(rootFieldNames([field('product'), field('productsPaged')])).toEqual([
      'product',
      'productsPaged',
    ]);
  });

  it('returns null when the fields cannot be known from the selection set', () => {
    // A root fragment spread's contents live elsewhere in the document.
    // Null means STRICT, not "assume none" -- see cachePolicyFor.
    expect(
      rootFieldNames([{ kind: 'FragmentSpread', name: { value: 'f' } }]),
    ).toBeNull();
    expect(rootFieldNames([{ kind: 'InlineFragment' }])).toBeNull();
    expect(rootFieldNames([])).toBeNull();
    expect(rootFieldNames(undefined)).toBeNull();
    expect(rootFieldNames([{ kind: 'Field' }])).toBeNull();
  });
});

describe('cachePolicyFor', () => {
  it('never lets a LISTING be served stale', () => {
    // A listing is how a buyer discovers what exists, so a withdrawn item
    // still showing -- or a new one missing -- is worse than the
    // revalidation round trip it costs.
    for (const field of ['productsPaged', 'products']) {
      const value = cachePolicyFor([field]);
      expect(value).toContain('must-revalidate');
      expect(value).not.toContain('stale-while-revalidate');
    }
  });

  it('lets a product DETAIL be served stale while it refreshes', () => {
    const value = cachePolicyFor(['product']);
    expect(value).toContain('stale-while-revalidate');
    // must-revalidate would forbid exactly what SWR authorises, and a
    // cache honouring both does the strict thing -- making the window
    // dead weight. Its absence IS the policy.
    expect(value).not.toContain('must-revalidate');
  });

  it('takes the STRICT policy when one request selects both', () => {
    // One header governs the whole response, so a request selecting a
    // detail alongside a listing cannot serve the listing half stale.
    const value = cachePolicyFor(['product', 'productsPaged']);
    expect(value).toContain('must-revalidate');
    expect(value).not.toContain('stale-while-revalidate');
  });

  it('fails CLOSED for anything it does not recognise', () => {
    // A new query silently inheriting permission to serve stale data is
    // the failure being designed out; guessing the other way costs one
    // revalidation. null is what rootFieldNames returns when it cannot
    // read the operation at all.
    for (const fields of [['somethingNew'], [], null, undefined]) {
      expect({ fields, policy: cachePolicyFor(fields) }).toEqual({
        fields,
        policy: expect.stringContaining('must-revalidate'),
      });
    }
  });
});

describe('cache policy TTLs', () => {
  // Asserted against the exported constants rather than literals, so
  // tuning one actually moves the header -- a literal here would let the
  // two drift while both looked tested.
  it('uses the shared max-age on both policies', () => {
    for (const value of [
      cachePolicyFor(['productsPaged']),
      cachePolicyFor(['product']),
    ]) {
      expect(value).toContain(`s-maxage=${GRAPHQL_SHARED_MAX_AGE_SECONDS}`);
      expect(value).toContain(`max-age=${GRAPHQL_SHARED_MAX_AGE_SECONDS}`);
    }
  });

  it('bounds the stale window, on the detail policy only', () => {
    // Longer than the fresh window on purpose: past s-maxage the data is
    // stale but still far better than a spinner, and the refresh happens
    // off the critical path. Bounded because there is no invalidation
    // path yet, so it doubles as worst-case staleness after a seller edit.
    expect(GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS).toBeGreaterThan(
      GRAPHQL_SHARED_MAX_AGE_SECONDS,
    );
    expect(cachePolicyFor(['product'])).toContain(
      `stale-while-revalidate=${GRAPHQL_STALE_WHILE_REVALIDATE_SECONDS}`,
    );
    expect(cachePolicyFor(['productsPaged'])).not.toContain(
      'stale-while-revalidate',
    );
  });
});
