import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
} from '@medinstru/config';
import {
  InquiriesService,
  buildInquiryMessage,
  hashIp,
} from './inquiries.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';

const PRODUCT = {
  id: 'seed-product-01',
  name: 'Portable Digital X-Ray Machine',
  sellerId: 'org-1',
  seller: { id: 'org-1', whatsappNumber: '+919876543210' },
};

const ARGS = {
  productId: 'seed-product-01',
  buyerName: 'Asha Rao',
  buyerPhone: '+919000000001',
  message: 'Is this available in Chennai?',
};

describe('buildInquiryMessage', () => {
  const message = buildInquiryMessage({
    productName: 'Portable Digital X-Ray Machine',
    productId: 'seed-product-01',
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Is this available in Chennai?',
    siteUrl: 'https://laxair.shop',
  });

  it('identifies the product without a round trip (#91 story 4)', () => {
    expect(message).toContain('Portable Digital X-Ray Machine');
    expect(message).toContain('seed-product-01');
  });

  it('carries the same canonical URL a buyer would share', () => {
    // A forwarded inquiry and a forwarded link must land on one page.
    expect(message).toContain(
      'https://laxair.shop/en/products/seed-product-01',
    );
  });

  it('does not double the slash when the site URL has a trailing one', () => {
    const trailing = buildInquiryMessage({
      productName: 'X',
      productId: 'p1',
      buyerName: 'B',
      buyerPhone: '+919000000001',
      message: 'hi',
      siteUrl: 'https://laxair.shop/',
    });
    expect(trailing).toContain('https://laxair.shop/en/products/p1');
    expect(trailing).not.toContain('shop//en');
  });

  it('includes how to reach the buyer back', () => {
    expect(message).toContain('Asha Rao');
    expect(message).toContain('+919000000001');
  });
});

describe('InquiriesService', () => {
  let service: InquiriesService;
  let prisma: {
    $transaction: jest.Mock;
    product: { findUnique: jest.Mock };
    inquiry: { create: jest.Mock; update: jest.Mock; count: jest.Mock };
  };
  let whatsapp: { sendInquiry: jest.Mock };

  beforeEach(() => {
    prisma = {
      // $transaction hands the callback a client; the mock passes the same
      // object back so assertions on prisma.inquiry.* still see every call
      // the service makes inside the transaction.
      $transaction: jest
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) =>
          Promise.resolve(fn(prisma)),
        ),
      product: { findUnique: jest.fn().mockResolvedValue(PRODUCT) },
      inquiry: {
        create: jest.fn().mockResolvedValue({ id: 'inq-1' }),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve({ id: 'inq-1', ...(data as object) }),
          ),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    whatsapp = {
      sendInquiry: jest
        .fn()
        .mockResolvedValue({ ok: true, providerMessageId: 'wamid.1' }),
    };
    service = new InquiriesService(
      prisma as unknown as PrismaService,
      whatsapp as unknown as WhatsappService,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('canonicalises a spaced number to E.164 before storing it', async () => {
    // The form advertises "+91 98765 43210" because that is how people write
    // numbers, and IsPhoneNumber accepts it -- but the sender rejects any
    // space, so the inquiry was stored and then failed at send time, which a
    // buyer only discovers by never getting a reply.
    await service.create({ ...ARGS, buyerPhone: '+91 98765 43210' });

    const written = prisma.inquiry.create.mock.calls[0][0] as {
      data: { buyerPhone: string };
    };
    expect(written.data.buyerPhone).toBe('+919876543210');
  });

  it('rejects a number that cannot be made valid', async () => {
    await expect(
      service.create({ ...ARGS, buyerPhone: 'not-a-number' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('rate-limits on the CANONICAL number, not the typed one', async () => {
    // Otherwise the same number written three ways is three buckets, and the
    // per-phone limit is trivially sidestepped with spaces.
    await service.create({ ...ARGS, buyerPhone: '+91 98765 43210' });

    const buckets = prisma.inquiry.count.mock.calls
      .map(
        (call) =>
          (call[0] as { where: { buyerPhone?: string } }).where.buyerPhone,
      )
      .filter(Boolean);
    expect(buckets.every((b) => b === '+919876543210')).toBe(true);
  });

  it('rejects an inquiry about a product that does not exist', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.create(ARGS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('records the inquiry BEFORE attempting delivery', async () => {
    // The whole design. Sending first and persisting after would discard a
    // real buyer on every provider hiccup.
    const order: string[] = [];
    prisma.inquiry.create.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({ id: 'inq-1' });
    });
    whatsapp.sendInquiry.mockImplementation(() => {
      order.push('send');
      return Promise.resolve({ ok: true, providerMessageId: 'wamid.1' });
    });

    await service.create(ARGS);

    expect(order).toEqual(['persist', 'send']);
  });

  it('marks a delivered inquiry SENT and keeps the provider message id', async () => {
    const result = await service.create(ARGS);

    expect(result).toMatchObject({
      status: 'SENT',
      providerMessageId: 'wamid.1',
    });
  });

  it('denormalizes the seller so a later product reassignment cannot rewrite history', async () => {
    await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sellerId: 'org-1' }),
      }),
    );
  });

  it('still records the lead when the provider rejects the send', async () => {
    whatsapp.sendInquiry.mockResolvedValue({
      ok: false,
      reason: 'provider 400',
    });

    const result = await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('still records the lead when the seller has no WhatsApp number', async () => {
    // A seller not yet onboarded is a configuration state, not a buyer error.
    prisma.product.findUnique.mockResolvedValue({
      ...PRODUCT,
      seller: { id: 'org-1', whatsappNumber: null },
    });

    const result = await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalled();
    expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('truncates a runaway provider failure reason', async () => {
    whatsapp.sendInquiry.mockResolvedValue({
      ok: false,
      reason: 'x'.repeat(5000),
    });

    const result = (await service.create(ARGS)) as { failureReason: string };

    expect(result.failureReason.length).toBe(500);
  });

  it('never sends the seller number to the buyer path', async () => {
    const result = await service.create(ARGS);
    expect(JSON.stringify(result)).not.toContain('+919876543210');
  });

  describe('rate limiting', () => {
    it('rejects once the per-phone limit is reached', async () => {
      prisma.inquiry.count
        .mockResolvedValueOnce(INQUIRY_RATE_LIMIT_PER_PHONE)
        .mockResolvedValueOnce(0);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('rejects once the per-phone-per-product limit is reached', async () => {
      // Stops one buyer pestering one seller about one item, which the
      // broader per-phone limit alone would allow up to its ceiling.
      prisma.inquiry.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('counts from the database, not an in-process counter', async () => {
      // An in-memory counter resets on deploy and is per-instance, so it
      // would be defeated by a restart or by horizontal scaling.
      await service.create(ARGS);
      // Three when no address resolved: per-phone, per-phone-product and the
      // per-seller cap. The IP bucket is deliberately skipped rather than
      // counted as null -- collapsing every unresolvable caller into one
      // shared bucket would let a single one lock out all the others.
      expect(prisma.inquiry.count).toHaveBeenCalledTimes(3);
    });

    it('adds an IP bucket when the address resolves', async () => {
      // The dimension the caller cannot type. Without it, rotating E.164
      // numbers defeats every other limit here.
      await service.create({ ...ARGS, callerIp: '203.0.113.7' });

      expect(prisma.inquiry.count).toHaveBeenCalledTimes(4);
      const buckets = prisma.inquiry.count.mock.calls.map((call) =>
        Object.keys((call[0] as { where: object }).where)
          .sort()
          .join(','),
      );
      expect(buckets).toContain('createdAt,ipHash');
    });

    it('stores the address hashed, never in the clear', async () => {
      // A raw IP is personal data under DPDP sitting in a table operators
      // read to triage leads. A hash still counts repeats.
      await service.create({ ...ARGS, callerIp: '203.0.113.7' });

      const written = prisma.inquiry.create.mock.calls[0][0] as {
        data: { ipHash: string };
      };
      expect(written.data.ipHash).not.toContain('203.0.113.7');
      expect(written.data.ipHash).toMatch(/[0-9a-f]{64}$/);
    });

    it('keys the hash when a secret is configured', () => {
      // An UNKEYED SHA-256 of an IPv4 address is not the protection it looks
      // like: 2^32 is small enough to enumerate, so anyone holding the table
      // can recover the address by hashing guesses. The key makes that
      // impossible without also holding the secret.
      const keyed = hashIp('203.0.113.7', { INQUIRY_IP_HASH_SECRET: 's3cret' });
      const unkeyed = hashIp('203.0.113.7', {});

      expect(keyed).toMatch(/^[0-9a-f]{64}$/);
      expect(keyed).not.toBe(unkeyed);
      // Deterministic, or it could not group repeats.
      expect(hashIp('203.0.113.7', { INQUIRY_IP_HASH_SECRET: 's3cret' })).toBe(
        keyed,
      );
    });

    it('marks the weaker unkeyed form in the data rather than hiding it', () => {
      // Visible in the column, so the weaker variant is distinguishable from
      // the keyed one rather than silently indistinguishable.
      expect(hashIp('203.0.113.7', {})).toMatch(/^unkeyed:/);
      expect(
        hashIp('203.0.113.7', { INQUIRY_IP_HASH_SECRET: 's' }),
      ).not.toMatch(/^unkeyed:/);
    });

    it('rejects once the per-IP limit is reached', async () => {
      // Asserted directly, not merely that the count happens -- the review
      // pointed out the old test proved the query ran and nothing more.
      prisma.inquiry.count.mockImplementation(
        ({ where }: { where: { ipHash?: string } }) =>
          Promise.resolve(where.ipHash ? INQUIRY_RATE_LIMIT_PER_IP : 0),
      );

      await expect(
        service.create({ ...ARGS, callerIp: '203.0.113.7' }),
      ).rejects.toThrow(/from this network/);
    });

    it("caps a seller's total exposure whatever the source", async () => {
      // The only limit still standing when an attacker rotates BOTH phone
      // numbers and addresses, so it is what actually bounds the spam a
      // seller can be made to receive.
      prisma.inquiry.count.mockImplementation(
        ({ where }: { where: { sellerId?: string } }) =>
          Promise.resolve(where.sellerId ? INQUIRY_RATE_LIMIT_PER_SELLER : 0),
      );

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('does not tell the caller which seller cap they hit', async () => {
      // Naming it hands an attacker a progress indicator for the one limit
      // they cannot rotate around.
      prisma.inquiry.count.mockImplementation(
        ({ where }: { where: { sellerId?: string } }) =>
          Promise.resolve(where.sellerId ? INQUIRY_RATE_LIMIT_PER_SELLER : 0),
      );

      await expect(service.create(ARGS)).rejects.toThrow(
        /Too many inquiries right now/,
      );
    });

    it('retries a serialization conflict instead of surfacing a 500', async () => {
      // Serializable isolation does not queue conflicting transactions, it
      // ABORTS one -- Prisma reports P2034. Without a retry, two buyers
      // submitting at the same instant meant one received an internal error
      // rather than succeeding or being told about the rate limit.
      const conflict = new Prisma.PrismaClientKnownRequestError(
        'write conflict',
        { code: 'P2034', clientVersion: 'test' },
      );
      let attempts = 0;
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(conflict);
        return Promise.resolve(fn(prisma));
      });

      await expect(service.create(ARGS)).resolves.toBeDefined();
      expect(attempts).toBe(2);
    });

    it('does NOT retry a rate-limit rejection', async () => {
      // Retrying a deliberate refusal would turn one rejection into three.
      let attempts = 0;
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        attempts += 1;
        return Promise.resolve(fn(prisma));
      });
      prisma.inquiry.count.mockResolvedValue(INQUIRY_RATE_LIMIT_PER_PHONE);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(attempts).toBe(1);
    });

    it('gives up after a bounded number of conflicts', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValue(conflict);

      await expect(service.create(ARGS)).rejects.toBe(conflict);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('runs the check and the insert in one serializable transaction', async () => {
      // Counting and then inserting separately is a time-of-check/
      // time-of-use race: concurrent callers all read a count below the
      // threshold and all proceed.
      await service.create(ARGS);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const options = prisma.$transaction.mock.calls[0][1] as {
        isolationLevel: string;
      };
      expect(options.isolationLevel).toBe('Serializable');
    });

    it('checks the limit before writing anything', async () => {
      prisma.inquiry.count.mockResolvedValue(INQUIRY_RATE_LIMIT_PER_PHONE);
      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
      expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
    });
  });
});
