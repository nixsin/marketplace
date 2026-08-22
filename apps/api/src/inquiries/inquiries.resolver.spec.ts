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
        failureReason: 'seller has no WhatsApp number',
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

  it('reports delivered only when the provider accepted it', async () => {
    expect(
      (await makeResolver('SENT').resolver.createInquiry(input, {})).delivered,
    ).toBe(true);
    expect(
      (await makeResolver('PENDING').resolver.createInquiry(input, {}))
        .delivered,
    ).toBe(false);
    expect(
      (await makeResolver('FAILED').resolver.createInquiry(input, {}))
        .delivered,
    ).toBe(false);
  });

  it('returns nothing a caller could mine', async () => {
    // This mutation is unauthenticated, so everything returned is readable by
    // whoever called it. Echoing the message back, or surfacing why delivery
    // failed, hands an anonymous caller information about the seller's setup.
    const result = await makeResolver('FAILED').resolver.createInquiry(
      input,
      {},
    );

    expect(Object.keys(result).sort()).toEqual([
      'createdAt',
      'delivered',
      'id',
      'status',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('WhatsApp number');
    expect(serialized).not.toContain(input.message);
    expect(serialized).not.toContain(input.buyerPhone);
  });
});

describe('resolveCallerIp', () => {
  const req = {
    ip: '10.0.0.9',
    socket: { remoteAddress: '10.0.0.10' },
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.5, 10.0.0.1',
    },
  };

  it('yields NO address at all by default', () => {
    // The finding this exists for. An earlier version trusted
    // cf-connecting-ip unconditionally, claiming a client could not forge it
    // -- true only if every route to the origin goes through Cloudflare, and
    // this origin answers directly on its .onrender.com hostname. A caller
    // skipping the edge could set a fresh value per request and walk straight
    // past the per-IP limit.
    // null, not the socket address. Behind Render's load balancer -- which
    // fronts every service -- socket.remoteAddress is the BALANCER, identical
    // for every buyer. Returning it gave everyone one shared ipHash, so after
    // INQUIRY_RATE_LIMIT_PER_IP inquiries the limit rejected every caller for
    // every seller: a global outage of the feature, caused by the fix for the
    // spoofing problem. Without trusted headers there is no per-client
    // address, so the honest answer is none, and the limiter skips it.
    expect(resolveCallerIp(req, {})).toBeNull();
  });

  it('never leaks req.ip OR the socket through while the flag is off', () => {
    // req.ip because Express derives it from X-Forwarded-For whenever
    // app-level `trust proxy` is enabled -- a setting invisible from here.
    // The socket because behind a load balancer it is the balancer, shared by
    // every buyer, which turned the per-IP limit into a global lockout.
    expect(
      resolveCallerIp(
        { ip: '203.0.113.99', socket: { remoteAddress: '10.0.0.10' } },
        {},
      ),
    ).toBeNull();
  });

  it('trusts them only when explicitly enabled', () => {
    expect(resolveCallerIp(req, { INQUIRY_TRUST_PROXY_HEADERS: 'true' })).toBe(
      '203.0.113.7',
    );
  });

  it('is not enabled by any truthy-looking value', () => {
    // A deployment flag this consequential should turn on for exactly one
    // string, not for "1", "yes" or "TRUE".
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      expect(resolveCallerIp(req, { INQUIRY_TRUST_PROXY_HEADERS: value })).toBe(
        null,
      );
    }
  });

  it('prefers cf-connecting-ip over x-forwarded-for when trusting', () => {
    const noCf = {
      ...req,
      headers: { 'x-forwarded-for': '198.51.100.5, 10.0.0.1' },
    };
    expect(resolveCallerIp(noCf, { INQUIRY_TRUST_PROXY_HEADERS: 'true' })).toBe(
      '198.51.100.5',
    );
  });

  it('reads only the first entry of a comma-separated forwarded chain', () => {
    // The left-most is the originating client; the rest are appended by
    // intermediaries.
    const chained = {
      headers: { 'x-forwarded-for': ' 198.51.100.5 , 10.0.0.1 , 10.0.0.2 ' },
    };
    expect(
      resolveCallerIp(chained, { INQUIRY_TRUST_PROXY_HEADERS: 'true' }),
    ).toBe('198.51.100.5');
  });

  it('falls back to the socket only in the trusted mode, then to null', () => {
    // In the opted-in mode the socket is a legitimate last resort, because an
    // operator has asserted the proxy chain is real.
    expect(
      resolveCallerIp(
        { socket: { remoteAddress: '10.0.0.10' } },
        { INQUIRY_TRUST_PROXY_HEADERS: 'true' },
      ),
    ).toBe('10.0.0.10');
    // null, never a placeholder: the limiter skips a null bucket, because
    // collapsing every unresolvable caller into one shared bucket would let a
    // single one of them lock out all the others.
    expect(
      resolveCallerIp({}, { INQUIRY_TRUST_PROXY_HEADERS: 'true' }),
    ).toBeNull();
    expect(resolveCallerIp(undefined, {})).toBeNull();
  });
});
