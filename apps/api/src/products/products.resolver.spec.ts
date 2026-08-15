import { ProductsResolver } from './products.resolver';
import { ProductsService } from './products.service';

describe('ProductsResolver', () => {
  let resolver: ProductsResolver;
  let mockProductsService: { findPage: jest.Mock; findPaged: jest.Mock };

  beforeEach(() => {
    mockProductsService = { findPage: jest.fn(), findPaged: jest.fn() };
    resolver = new ProductsResolver(
      mockProductsService as unknown as ProductsService,
    );
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
