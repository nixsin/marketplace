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
