import {
  Args,
  ID,
  Int,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { Product } from './models/product.model';
import { isE164 } from '../inquiries/phone';
import { ProductPage } from './models/product-page.model';
import { ProductsPaged } from './models/products-paged.model';

// Explicit parent type, required for the hasInquiryContact field resolver
// below. A bare @Resolver() cannot host @ResolveField -- Nest raises
// UndefinedResolverTypeError at boot, not at build, so this fails as a
// container crash rather than a compile error.
@Resolver(() => Product)
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

  /**
   * A syntactically valid contact number is configured -- not that it is
   * verified, and not that it can be reached. See the field's own comment on
   * the Product model for why the name is precise about that.
   */
  @ResolveField(() => Boolean)
  hasInquiryContact(
    @Parent() product: { seller?: { whatsappNumber?: string | null } },
  ): boolean {
    // The SAME E.164 rule the send applies, not merely "is it non-empty".
    // The column is free text, so a malformed number would otherwise advertise
    // that the product can receive inquiries and render the form, while every
    // send fails validation before it leaves the process -- a buyer typing a
    // real question into a form that could never work.
    const number = product.seller?.whatsappNumber;
    return typeof number === 'string' && isE164(number);
  }
}
