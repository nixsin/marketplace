import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { ProductPage } from './models/product-page.model';
import { ProductsPaged } from './models/products-paged.model';

@Resolver()
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

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
