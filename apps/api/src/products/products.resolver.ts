import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { ProductPage } from './models/product-page.model';

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
}
