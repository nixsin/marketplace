// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { InquiriesResolver, resolveCallerIp } from './inquiries.resolver';
import { InquiriesService } from './inquiries.service';

describe('InquiriesResolver', () => {
  const input = {
    idempotencyKey: 'test-submission-key-0001',
    productId: 'seed-product-01',
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Is this available in Chennai?',
  };

  function makeResolver(status: 'PENDING' | 'SENT' | 'FAILED') {
    const service = {
      create: jest.fn().mockResolvedValue({
        id: 'inq-1',
        status,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        // Present on the row, and deliberately not returned to the buyer.
        buyerPhone: input.buyerPhone,
        message: input.message,
        ipHash: 'c0ffee'.repeat(10),
      }),
    };
    return {
      service,
      resolver: new InquiriesResolver(service as unknown as InquiriesService),
    };
  }

  it('delegates to the service', async () => {
    const { resolver, service } = makeResolver('SENT');
    await resolver.createInquiry(input, {});
    expect(service.create).toHaveBeenCalledWith({ ...input, callerIp: null });
  });

  it('returns nothing a caller could mine', async () => {
    // This mutation is unauthenticated, so everything returned is readable by
    // whoever called it. The service returns the whole row; spreading it into
    // the response would echo the buyer's own message and phone number back
    // to an anonymous caller, and hand out the ipHash of whoever asked before
    // them.
    //
    // Asserted on the KEYS, not on a few known-bad fields: the row grows a
    // column every time this feature does, and a test naming today's columns
    // passes cleanly the moment a new one is added.
    const result = await makeResolver('FAILED').resolver.createInquiry(
      input,
      {},
    );

    // `status` is gone, and that is the point rather than an omission: it
    // was a real delivery outcome handed to an unauthenticated caller, so
    // anyone could probe whether a seller is currently reachable.
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'id']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(input.message);
    expect(serialized).not.toContain(input.buyerPhone);
    expect(serialized).not.toContain('c0ffee');
  });
});

describe('resolveCallerIp', () => {
  const trusted = { INQUIRY_TRUST_PROXY_HEADERS: 'true' };
  const req = {
    ip: '10.0.0.9',
    socket: { remoteAddress: '10.0.0.10' },
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.5, 10.0.0.1',
    },
  };

  it('yields NO address at all by default', () => {
    // An earlier version trusted cf-connecting-ip unconditionally, claiming a
    // client could not forge it -- true only if every route to the origin
    // goes through Cloudflare, and this origin answers directly on its
    // .onrender.com hostname. A caller skipping the edge could set a fresh
    // value per request and walk past the per-IP limit.
    expect(resolveCallerIp(req, {})).toBeNull();
  });

  it('never leaks req.ip OR the socket through while the flag is off', () => {
    expect(
      resolveCallerIp(
        { ip: '203.0.113.99', socket: { remoteAddress: '10.0.0.10' } },
        {},
      ),
    ).toBeNull();
  });

  it('trusts cf-connecting-ip only when explicitly enabled', () => {
    expect(resolveCallerIp(req, trusted)).toBe('203.0.113.7');
  });

  it('is not enabled by any truthy-looking value', () => {
    // A deployment flag this consequential should turn on for exactly one
    // string, not for "1", "yes" or "TRUE".
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      expect(
        resolveCallerIp(req, { INQUIRY_TRUST_PROXY_HEADERS: value }),
      ).toBeNull();
    }
  });

  it('IGNORES x-forwarded-for entirely, even in the trusted mode', () => {
    // The finding this exists for, and the previous version of this file
    // asserted the opposite as if it were intended.
    //
    // Proxies APPEND to x-forwarded-for rather than overwriting it, so a
    // client can send their own chain and the proxy adds to it -- leaving the
    // left-most entry, nominally "the originating client", under the
    // attacker's control. Rotating it walked straight past the per-IP limit
    // on any trusted route where cf-connecting-ip happened to be absent.
    // cf-connecting-ip is safe precisely because Cloudflare overwrites it.
    const noCf = {
      headers: { 'x-forwarded-for': '198.51.100.5, 10.0.0.1' },
    };
    expect(resolveCallerIp(noCf, trusted)).toBeNull();
  });

  it('does not fall back to req.ip, which is derived from that same header', () => {
    // Express sets req.ip from X-Forwarded-For whenever app-level
    // `trust proxy` is enabled -- a setting invisible from here -- so it
    // inherits the forgery exactly.
    expect(resolveCallerIp({ ip: '198.51.100.5' }, trusted)).toBeNull();
  });

  it('does not fall back to the socket, which is the load balancer', () => {
    // Unforgeable but not per-client: Render fronts every service with a
    // balancer, so this is the SAME value for every buyer. Using it gave
    // everyone one shared bucket, and once the per-IP limit was reached it
    // rejected every caller for every seller -- a global outage of the
    // feature, caused by the fix for the forgery problem. null is the honest
    // answer, and the limiter skips a null bucket.
    expect(
      resolveCallerIp({ socket: { remoteAddress: '10.0.0.10' } }, trusted),
    ).toBeNull();
    expect(resolveCallerIp({}, trusted)).toBeNull();
    expect(resolveCallerIp(undefined, {})).toBeNull();
  });

  it('refuses a cf-connecting-ip carrying a chain', () => {
    // The real header carries exactly one address. A comma means it did not
    // come from the edge, and splitting it would quietly accept the
    // forgeable shape this function exists to refuse.
    expect(
      resolveCallerIp(
        { headers: { 'cf-connecting-ip': '198.51.100.5, 10.0.0.1' } },
        trusted,
      ),
    ).toBeNull();
  });

  it('reads the first entry when the header arrives more than once', () => {
    expect(
      resolveCallerIp(
        { headers: { 'cf-connecting-ip': ['203.0.113.7', '10.0.0.1'] } },
        trusted,
      ),
    ).toBe('203.0.113.7');
  });
});
