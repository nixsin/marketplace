import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSONObject } from 'graphql-type-json';
import { DeviceClass } from '../../../generated/prisma/enums';
import { Organization } from '../../organizations/models/organization.model';

registerEnumType(DeviceClass, { name: 'DeviceClass' });

@ObjectType()
export class Product {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  brand: string;

  @Field()
  category: string;

  @Field(() => DeviceClass, { nullable: true })
  deviceClass?: DeviceClass;

  @Field(() => [String])
  certifications: string[];

  @Field()
  location: string;

  @Field()
  description: string;

  @Field({ nullable: true })
  imageUrl?: string;

  // Category-specific specs (blade size, power rating, etc.) -- schema-less
  // by design, see the Prisma model's own comment for why. GraphQLJSONObject
  // is the established NestJS pattern for exposing a Prisma Json field:
  // passed directly as the @Field(() => ...) type, no separate @Scalar
  // resolver class needed.
  @Field(() => GraphQLJSONObject, { nullable: true })
  details?: Record<string, unknown> | null;

  @Field(() => Organization)
  seller: Organization;

  /**
   * A syntactically valid contact number is CONFIGURED for this seller.
   *
   * Deliberately not called canReceiveInquiries, and the distinction is not
   * pedantic: it was, and the name promised reachability the check cannot
   * establish. The seed fills the reserved +999 range precisely BECAUSE those
   * numbers cannot route anywhere, and they satisfied the old name -- the flag
   * said "can receive inquiries" about numbers chosen for being undeliverable.
   *
   * What this actually answers is "will submitting an inquiry go anywhere at
   * all": with a number present the API attempts delivery and records the
   * lead; with none it does not try. Real reachability needs the provider's
   * own number verification, which arrives with the delivery integration.
   *
   * Exposes only the BOOLEAN, never the number. The send happens server-side
   * so a scraper cannot harvest seller numbers from the API, and #91 story 6
   * is explicit that sellers must not have staff exposed to unsolicited
   * contact. Resolved from the already-loaded seller relation, so it costs no
   * additional query.
   */
  hasInquiryContact: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
