import { InquiriesResolver } from './inquiries.resolver';
import { InquiriesService } from './inquiries.service';

describe('InquiriesResolver', () => {
  const input = {
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
    await resolver.createInquiry(input);
    expect(service.create).toHaveBeenCalledWith(input);
  });

  it('reports delivered only when the provider accepted it', async () => {
    expect(
      (await makeResolver('SENT').resolver.createInquiry(input)).delivered,
    ).toBe(true);
    expect(
      (await makeResolver('PENDING').resolver.createInquiry(input)).delivered,
    ).toBe(false);
    expect(
      (await makeResolver('FAILED').resolver.createInquiry(input)).delivered,
    ).toBe(false);
  });

  it('returns nothing a caller could mine', async () => {
    // This mutation is unauthenticated, so everything returned is readable by
    // whoever called it. Echoing the message back, or surfacing why delivery
    // failed, hands an anonymous caller information about the seller's setup.
    const result = await makeResolver('FAILED').resolver.createInquiry(input);

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

describe('InquiriesResolver.createBundleInquiry', () => {
  const input = {
    productIds: ['p1', 'p2'],
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Please quote.',
  };

  function makeResolver(sellerCount: number, deliveredSellerCount: number) {
    const service = {
      createBundle: jest.fn().mockResolvedValue({
        bundleId: 'b1',
        inquiries: [{ id: 'i1' }, { id: 'i2' }],
        skippedProductIds: ['p9'],
        sellerCount,
        deliveredSellerCount,
      }),
    };
    return new InquiriesResolver(service as unknown as InquiriesService);
  }

  it('reports delivered only when EVERY seller received it', async () => {
    // The mutation that exposed this: `deliveredSellerCount > 0` would call a
    // half-delivered shortlist a success, telling the buyer to expect replies
    // from sellers who never got the message.
    expect(
      (await makeResolver(2, 2).createBundleInquiry(input)).delivered,
    ).toBe(true);
    expect(
      (await makeResolver(2, 1).createBundleInquiry(input)).delivered,
    ).toBe(false);
    expect(
      (await makeResolver(2, 0).createBundleInquiry(input)).delivered,
    ).toBe(false);
  });

  it('never reports delivered when there are no sellers at all', async () => {
    // 0 === 0 is true, so a naive equality check would call an empty
    // submission fully delivered.
    expect(
      (await makeResolver(0, 0).createBundleInquiry(input)).delivered,
    ).toBe(false);
  });

  it('passes through the counts the UI needs to be specific', async () => {
    const result = await makeResolver(2, 2).createBundleInquiry(input);

    expect(result.sellerCount).toBe(2);
    expect(result.productCount).toBe(2);
    // Surfaced, not swallowed: the buyer selected these deliberately.
    expect(result.skippedProductIds).toEqual(['p9']);
  });
});
