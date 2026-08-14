import { ObjectType, Field } from '@nestjs/graphql';
import { Product } from './product.model';

@ObjectType()
export class ProductPage {
  @Field(() => [Product])
  items: Product[];

  @Field({ nullable: true })
  nextCursor?: string;
}
