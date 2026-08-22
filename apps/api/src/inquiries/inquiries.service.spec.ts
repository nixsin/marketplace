import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
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
    product: { findUnique: jest.Mock };
    inquiry: { create: jest.Mock; update: jest.Mock; count: jest.Mock };
  };
  let whatsapp: { sendText: jest.Mock };

  beforeEach(() => {
    prisma = {
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
    whatsapp.sendText.mockImplementation(() => {
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
    whatsapp.sendText.mockResolvedValue({ ok: false, reason: 'provider 400' });

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
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('truncates a runaway provider failure reason', async () => {
    whatsapp.sendText.mockResolvedValue({
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
      expect(prisma.inquiry.count).toHaveBeenCalledTimes(2);
    });

    it('checks the limit before writing anything', async () => {
      prisma.inquiry.count.mockResolvedValue(INQUIRY_RATE_LIMIT_PER_PHONE);
      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });
  });
});
