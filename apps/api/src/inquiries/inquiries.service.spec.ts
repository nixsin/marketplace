import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  INQUIRY_BULK_MAX_PRODUCTS,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
} from '@medinstru/config';
import { InquiriesService, buildInquiryMessage } from './inquiries.service';
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
    products: [
      { id: 'seed-product-01', name: 'Portable Digital X-Ray Machine' },
    ],
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
      products: [{ id: 'p1', name: 'X' }],
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
    product: { findUnique: jest.Mock; findMany: jest.Mock };
    inquiry: {
      create: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
      createMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let whatsapp: { sendText: jest.Mock };

  beforeEach(() => {
    prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue(PRODUCT),
        findMany: jest.fn().mockResolvedValue([PRODUCT]),
      },
      inquiry: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ id: 'inq-1', ...data }),
          ),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve({ id: 'inq-1', ...(data as object) }),
          ),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    whatsapp = {
      sendText: jest
        .fn()
        .mockResolvedValue({ ok: true, providerMessageId: 'wamid.1' }),
    };
    service = new InquiriesService(
      prisma as unknown as PrismaService,
      whatsapp as unknown as WhatsappService,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  /**
   * Rows are read back after the delivery outcome is applied, so a test that
   * asserts on the returned row states what findMany should answer with.
   * Kept explicit rather than hidden in beforeEach: the returned status is
   * the thing most of these tests are actually about.
   */
  function respondWith(row: Record<string, unknown>) {
    prisma.inquiry.findMany.mockImplementation(
      ({ where }: { where?: { bundleId?: string } }) =>
        Promise.resolve(where?.bundleId ? [{ id: 'inq-1', ...row }] : []),
    );
  }

  afterEach(() => jest.restoreAllMocks());

  it('rejects an inquiry about a product that does not exist', async () => {
    prisma.product.findMany.mockResolvedValue([]);
    await expect(service.create(ARGS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.inquiry.createMany).not.toHaveBeenCalled();
  });

  it('records the inquiry BEFORE attempting delivery', async () => {
    // The whole design. Sending first and persisting after would discard a
    // real buyer on every provider hiccup.
    const order: string[] = [];
    prisma.inquiry.createMany.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({ count: 1 });
    });
    whatsapp.sendText.mockImplementation(() => {
      order.push('send');
      return Promise.resolve({ ok: true, providerMessageId: 'wamid.1' });
    });

    await service.create(ARGS);

    expect(order).toEqual(['persist', 'send']);
  });

  it('marks a delivered inquiry SENT and keeps the provider message id', async () => {
    respondWith({ status: 'SENT', providerMessageId: 'wamid.1' });
    const result = await service.create(ARGS);

    expect(result).toMatchObject({
      status: 'SENT',
      providerMessageId: 'wamid.1',
    });
  });

  it('denormalizes the seller so a later product reassignment cannot rewrite history', async () => {
    await service.create(ARGS);

    expect(prisma.inquiry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sellerId: 'org-1' })],
      }),
    );
  });

  it('still records the lead when the provider rejects the send', async () => {
    whatsapp.sendText.mockResolvedValue({ ok: false, reason: 'provider 400' });
    respondWith({ status: 'FAILED', failureReason: 'provider 400' });

    const result = await service.create(ARGS);

    expect(prisma.inquiry.createMany).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('still records the lead when the seller has no WhatsApp number', async () => {
    // A seller not yet onboarded is a configuration state, not a buyer error.
    prisma.product.findMany.mockResolvedValue([
      { ...PRODUCT, seller: { id: 'org-1', whatsappNumber: null } },
    ]);
    respondWith({
      status: 'FAILED',
      failureReason: 'seller has no WhatsApp number',
    });

    const result = await service.create(ARGS);

    expect(prisma.inquiry.createMany).toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('truncates a runaway provider failure reason', async () => {
    whatsapp.sendText.mockResolvedValue({
      ok: false,
      reason: 'x'.repeat(5000),
    });

    await service.create(ARGS);

    // Asserted on what was WRITTEN, not on the row read back: the cap exists
    // to keep an operator-facing column bounded, so the write is the moment
    // that matters.
    const written = prisma.inquiry.updateMany.mock.calls[0][0] as {
      data: { failureReason: string };
    };
    expect(written.data.failureReason.length).toBe(500);
  });

  it('never sends the seller number to the buyer path', async () => {
    respondWith({ status: 'SENT', providerMessageId: 'wamid.1' });
    const result = await service.create(ARGS);
    expect(JSON.stringify(result)).not.toContain('+919876543210');
  });

  describe('rate limiting', () => {
    it('rejects once the per-phone limit is reached', async () => {
      prisma.inquiry.findMany.mockResolvedValue(
        Array.from({ length: INQUIRY_RATE_LIMIT_PER_PHONE }, (_, i) => ({
          bundleId: `b${i}`,
        })),
      );

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.createMany).not.toHaveBeenCalled();
    });

    it('rejects once the per-phone-per-product limit is reached', async () => {
      // Stops one buyer pestering one seller about one item, which the
      // broader per-phone limit alone would allow up to its ceiling.
      prisma.inquiry.groupBy.mockResolvedValue([
        {
          productId: 'seed-product-01',
          _count: { productId: INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT },
        },
      ]);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.createMany).not.toHaveBeenCalled();
    });

    it('counts from the database, not an in-process counter', async () => {
      // An in-memory counter resets on deploy and is per-instance, so it
      // would be defeated by a restart or by horizontal scaling.
      await service.create(ARGS);
      expect(prisma.inquiry.findMany).toHaveBeenCalled();
      expect(prisma.inquiry.groupBy).toHaveBeenCalled();
    });

    it('checks the limit before writing anything', async () => {
      prisma.inquiry.findMany.mockResolvedValue(
        Array.from({ length: INQUIRY_RATE_LIMIT_PER_PHONE }, (_, i) => ({
          bundleId: `b${i}`,
        })),
      );
      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.createMany).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });
  });
});

describe('InquiriesService.createBundle', () => {
  const P1 = {
    id: 'p1',
    name: 'X-Ray DR-200',
    sellerId: 'org-1',
    seller: { whatsappNumber: '+919876543210' },
  };
  const P2 = { ...P1, id: 'p2', name: 'Ultrasound US-Pro 7' };
  const OTHER_SELLER = { ...P1, id: 'p3', sellerId: 'org-2' };

  let service: InquiriesService;
  let prisma: {
    product: { findMany: jest.Mock };
    inquiry: {
      createMany: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
    };
  };
  let whatsapp: { sendText: jest.Mock };

  const ARGS = {
    productIds: ['p1', 'p2'],
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Please quote for both.',
  };

  beforeEach(() => {
    prisma = {
      product: { findMany: jest.fn().mockResolvedValue([P1, P2]) },
      inquiry: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        // Rate-limit read returns [], bundle read-back returns rows.
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where?: { bundleId?: string } }) =>
            Promise.resolve(
              where?.bundleId ? [{ id: 'i1' }, { id: 'i2' }] : [],
            ),
          ),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    whatsapp = {
      sendText: jest
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

  it('sends ONE message covering the whole shortlist', async () => {
    // Not one message per product: a seller should see everything they can
    // quote together, not reassemble it from separate messages.
    await service.createBundle(ARGS);

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    const body = whatsapp.sendText.mock.calls[0][1] as string;
    expect(body).toContain('X-Ray DR-200');
    expect(body).toContain('Ultrasound US-Pro 7');
    expect(body).toContain('(2 products)');
  });

  it('persists before sending, for a bundle too', async () => {
    // The single-product path's core invariant. A refactor of this method
    // once inverted it, and only a test of the sequence caught it.
    const order: string[] = [];
    prisma.inquiry.createMany.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({ count: 2 });
    });
    whatsapp.sendText.mockImplementation(() => {
      order.push('send');
      return Promise.resolve({ ok: true, providerMessageId: 'wamid.1' });
    });

    await service.createBundle(ARGS);

    expect(order).toEqual(['persist', 'send']);
  });

  it('writes one row per product, all sharing a bundle id', async () => {
    await service.createBundle(ARGS);

    const written = prisma.inquiry.createMany.mock.calls[0][0] as {
      data: { productId: string; bundleId: string }[];
    };
    expect(written.data.map((d) => d.productId)).toEqual(['p1', 'p2']);
    expect(new Set(written.data.map((d) => d.bundleId)).size).toBe(1);
  });

  it('rejects a selection spanning sellers rather than misdelivering it', async () => {
    // Single-seller marketplace today. Sending this to whichever seller came
    // first would hand one seller a list of a competitor's products and give
    // the buyer a confirmation nobody can answer.
    prisma.product.findMany.mockResolvedValue([P1, OTHER_SELLER]);

    await expect(
      service.createBundle({ ...ARGS, productIds: ['p1', 'p3'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.inquiry.createMany).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('dedupes repeated ids instead of writing the product twice', async () => {
    prisma.product.findMany.mockResolvedValue([P1]);

    await service.createBundle({ ...ARGS, productIds: ['p1', 'p1', 'p1'] });

    const written = prisma.inquiry.createMany.mock.calls[0][0] as {
      data: unknown[];
    };
    expect(written.data).toHaveLength(1);
  });

  it('rejects an empty selection', async () => {
    await expect(
      service.createBundle({ ...ARGS, productIds: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a selection over the cap', async () => {
    const tooMany = Array.from(
      { length: INQUIRY_BULK_MAX_PRODUCTS + 1 },
      (_, i) => `p${i}`,
    );
    await expect(
      service.createBundle({ ...ARGS, productIds: tooMany }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('rejects the whole submission if any product does not exist', async () => {
    prisma.product.findMany.mockResolvedValue([P1]);

    await expect(
      service.createBundle({ ...ARGS, productIds: ['p1', 'ghost'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('drops products already at their per-product limit, and reports them', async () => {
    // Rejecting a 20-item shortlist because one item was asked about an hour
    // ago is a worse outcome than sending the rest and saying so.
    prisma.inquiry.groupBy.mockResolvedValue([
      {
        productId: 'p2',
        _count: { productId: INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT },
      },
    ]);

    const result = await service.createBundle(ARGS);

    expect(result.skippedProductIds).toEqual(['p2']);
    const written = prisma.inquiry.createMany.mock.calls[0][0] as {
      data: { productId: string }[];
    };
    expect(written.data.map((d) => d.productId)).toEqual(['p1']);
  });

  it('refuses when every selected product is at its limit', async () => {
    prisma.inquiry.groupBy.mockResolvedValue([
      { productId: 'p1', _count: { productId: 99 } },
      { productId: 'p2', _count: { productId: 99 } },
    ]);

    await expect(service.createBundle(ARGS)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('counts SUBMISSIONS, not rows, against the per-phone limit', async () => {
    // Counting rows would let one 6-item shortlist exhaust an hourly budget
    // that five separate single inquiries would not.
    prisma.inquiry.findMany.mockImplementation(
      ({
        where,
        distinct,
      }: {
        where?: { bundleId?: string };
        distinct?: unknown;
      }) => {
        if (distinct) {
          return Promise.resolve(
            Array.from({ length: INQUIRY_RATE_LIMIT_PER_PHONE }, (_, i) => ({
              bundleId: `b${i}`,
            })),
          );
        }
        return Promise.resolve(where?.bundleId ? [{ id: 'i1' }] : []);
      },
    );

    await expect(service.createBundle(ARGS)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still records the shortlist when delivery fails', async () => {
    whatsapp.sendText.mockResolvedValue({ ok: false, reason: 'provider 400' });

    await service.createBundle(ARGS);

    expect(prisma.inquiry.createMany).toHaveBeenCalled();
    const applied = prisma.inquiry.updateMany.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(applied.data.status).toBe('FAILED');
  });

  it('applies one delivery outcome to every row in the bundle', async () => {
    // One message about three products must not report three delivery states.
    await service.createBundle(ARGS);

    expect(prisma.inquiry.updateMany).toHaveBeenCalledTimes(1);
    const applied = prisma.inquiry.updateMany.mock.calls[0][0] as {
      where: { bundleId: string };
    };
    expect(applied.where.bundleId).toBeTruthy();
  });
});
