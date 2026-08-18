import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { Product } from './models/product.model';
import { ProductPage } from './models/product-page.model';
import { ProductsPaged } from './models/products-paged.model';

@Resolver()
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  // Unlike organization(id) (removed -- see organizations.resolver.ts's own
  // comment), a client-supplied product(id) query is deliberately safe:
  // products are a publicly browsable catalog by design, not sensitive
  // per-org data like KYC status. The seller field here surfaces the same
  // Organization fields already exposed by products/productsPaged above
  // (name, gstin, kycStatus) -- no new data is reachable that a normal
  // catalog browse couldn't already reach. Don't treat this as a general
  // "findById-by-client-id is safe" precedent for other models -- see the
  // organization(id) removal for the case where it wasn't.
  @Query(() => Product)
  product(@Args('id', { type: () => ID }) id: string) {
    return this.productsService.findById(id);
  }

  @Query(() => ProductPage)
  products(
    @Args('cursor', { type: () => String, nullable: true }) cursor?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.productsService.findPage(cursor, limit ?? undefined);
  }

  @Query(() => ProductsPaged)
  productsPaged(
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ) {
    return this.productsService.findPaged(
      page ?? undefined,
      pageSize ?? undefined,
    );
  }
}
