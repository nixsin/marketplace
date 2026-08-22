import { ProductsResolver } from './products.resolver';
import { ProductsService } from './products.service';

describe('ProductsResolver', () => {
  let resolver: ProductsResolver;
  let mockProductsService: {
    findById: jest.Mock;
    findPage: jest.Mock;
    findPaged: jest.Mock;
  };

  beforeEach(() => {
    mockProductsService = {
      findById: jest.fn(),
      findPage: jest.fn(),
      findPaged: jest.fn(),
    };
    resolver = new ProductsResolver(
      mockProductsService as unknown as ProductsService,
    );
  });

  describe('product', () => {
    it('passes id through to productsService.findById', async () => {
      const expected = { id: 'p1', name: 'Product 1' };
      mockProductsService.findById.mockResolvedValue(expected);

      const result = await resolver.product('p1');

      expect(mockProductsService.findById).toHaveBeenCalledWith('p1');
      expect(result).toBe(expected);
    });
  });

  describe('products', () => {
    it('passes cursor and limit through to productsService.findPage', () => {
      const expected = { items: [], nextCursor: undefined };
      mockProductsService.findPage.mockReturnValue(expected);

      const result = resolver.products('product_5', 3);

      expect(mockProductsService.findPage).toHaveBeenCalledWith('product_5', 3);
      expect(result).toBe(expected);
    });

    it('calls findPage(undefined, undefined) when called with no args', () => {
      resolver.products();

      expect(mockProductsService.findPage).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
    });
  });

  describe('productsPaged', () => {
    it('passes page and pageSize through to productsService.findPaged', () => {
      const expected = { items: [], total: 0, page: 2, pageSize: 5 };
      mockProductsService.findPaged.mockReturnValue(expected);

      const result = resolver.productsPaged(2, 5);

      expect(mockProductsService.findPaged).toHaveBeenCalledWith(2, 5);
      expect(result).toBe(expected);
    });

    it('calls findPaged(undefined, undefined) when called with no args', () => {
      resolver.productsPaged();

      expect(mockProductsService.findPaged).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
    });
  });
});

describe('hasInquiryContact', () => {
  const resolver = new ProductsResolver({} as unknown as ProductsService);

  it('is true only for a genuinely sendable number', () => {
    expect(
      resolver.hasInquiryContact({
        seller: { whatsappNumber: '+919876543210' },
      }),
    ).toBe(true);
  });

  it.each<[string | null | undefined, string]>([
    ['98765 43210', 'local format with spaces'],
    ['not-a-number', 'free text'],
    ['+91', 'too short'],
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'absent'],
  ])('is false for %s (%s)', (value) => {
    // The column is free text, so a non-empty malformed value would otherwise
    // advertise that the product can receive inquiries and render the form,
    // while every send fails E.164 validation before leaving the process --
    // a buyer typing a real question into a form that could never work.
    expect(
      resolver.hasInquiryContact({ seller: { whatsappNumber: value } }),
    ).toBe(false);
  });

  it('is false when the seller relation is missing entirely', () => {
    expect(resolver.hasInquiryContact({})).toBe(false);
  });
});
