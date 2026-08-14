import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Product } from './product.model';

// Offset-based, deliberately — cursor pagination (ProductPage) can't
// support "jump to page 7" numbered navigation, only sequential "next".
// Fine at today's catalog size; see TECHNICAL_PLAN.md §12B for why this
// doesn't scale indefinitely and cursor pagination is the long-term default.
@ObjectType()
export class ProductsPaged {
  @Field(() => [Product])
  items: Product[];

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  pageSize: number;

  @Field(() => Int)
  totalCount: number;

  @Field(() => Int)
  totalPages: number;
}
