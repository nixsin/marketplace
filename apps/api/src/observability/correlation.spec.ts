import {
  correlationFields,
  getCorrelation,
  newRequestId,
  runWithCorrelation,
  sanitizeClientId,
} from './correlation';

describe('sanitizeClientId', () => {
  it('accepts the id shapes we actually issue', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(sanitizeClientId(uuid)).toBe(uuid);
    expect(sanitizeClientId('abc_123-XYZ')).toBe('abc_123-XYZ');
  });

  it('rejects a value carrying a newline', () => {
    // The reason this function exists. These values are written straight
    // into log lines, so a newline lets a caller forge whole entries --
    // e.g. appending a fake 'level=error' record attributed to us.
    expect(sanitizeClientId('abc\ndef')).toBeUndefined();
    expect(sanitizeClientId('a\r\nlevel=error msg=fake')).toBeUndefined();
  });

  it('rejects tabs, spaces and other control characters', () => {
    expect(sanitizeClientId('abc def')).toBeUndefined();
    expect(sanitizeClientId('abc\tdef')).toBeUndefined();
    expect(sanitizeClientId('abc\u0000def')).toBeUndefined();
  });

  it('rejects anything longer than the cap', () => {
    // Unbounded values bloat every log line they appear on.
    expect(sanitizeClientId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitizeClientId('a'.repeat(65))).toBeUndefined();
  });

  it('rejects empty and whitespace-only values', () => {
    expect(sanitizeClientId('')).toBeUndefined();
    expect(sanitizeClientId('   ')).toBeUndefined();
  });

  it('rejects non-strings, including the array Express gives a repeated header', () => {
    // A client can send the same header twice; Express then hands us
    // string[], not string. Silently stringifying that would put
    // 'a,b' into logs as though it were a single id.
    expect(sanitizeClientId(['a', 'b'])).toBeUndefined();
    expect(sanitizeClientId(undefined)).toBeUndefined();
    expect(sanitizeClientId(42)).toBeUndefined();
    expect(sanitizeClientId({})).toBeUndefined();
  });
});

describe('newRequestId', () => {
  it('is unique per call', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
    expect(ids.size).toBe(500);
  });

  it('passes our own sanitizer, so ids we issue survive a round trip', () => {
    // If the server's own id could not pass validation, a genuine
    // service-to-service hop forwarding it would silently drop it.
    const id = newRequestId();
    expect(sanitizeClientId(id)).toBe(id);
  });
});

describe('runWithCorrelation', () => {
  const base = { requestId: 'req-1', sessionId: 'sess-1' };

  it('exposes the correlation to synchronous callees', () => {
    runWithCorrelation(base, () => {
      expect(getCorrelation()?.requestId).toBe('req-1');
    });
  });

  it('survives await boundaries', async () => {
    // The whole point of AsyncLocalStorage over a parameter: a resolver
    // several awaits deep still attributes its logs correctly.
    await runWithCorrelation(base, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getCorrelation()?.requestId).toBe('req-1');
    });
  });

  it('keeps concurrent requests separate', async () => {
    // The failure this guards against is the worst kind: under load, one
    // request's logs attributed to another request's id.
    const seen: string[] = [];
    const run = (id: string, delay: number) =>
      runWithCorrelation({ requestId: id }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push(getCorrelation()!.requestId);
      });

    await Promise.all([run('a', 20), run('b', 5), run('c', 10)]);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined outside any request', () => {
    // Scheduled jobs, startup, tests. Callers must handle this.
    expect(getCorrelation()).toBeUndefined();
  });
});

describe('correlationFields', () => {
  it('omits fields the browser did not send', () => {
    expect(correlationFields({ requestId: 'r1' })).toEqual({
      request_id: 'r1',
    });
  });

  it('emits every field as its own flat attribute', () => {
    // Separate fields, not one composite id: 'everything in this session'
    // must be an indexed field filter, not a prefix match on a blob.
    expect(
      correlationFields({
        requestId: 'r1',
        sessionId: 's1',
        pageViewId: 'p1',
        clientRequestId: 'c1',
      }),
    ).toEqual({
      request_id: 'r1',
      session_id: 's1',
      page_view_id: 'p1',
      client_request_id: 'c1',
    });
  });

  it('reads the ambient correlation when given no argument', () => {
    runWithCorrelation({ requestId: 'r9' }, () => {
      expect(correlationFields()).toEqual({ request_id: 'r9' });
    });
  });
});
