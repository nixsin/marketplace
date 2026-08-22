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
   * Whether an inquiry can actually reach this seller (#91). Exposes only the
   * BOOLEAN, never the number itself -- the send happens server-side, so a
   * scraper cannot harvest seller WhatsApp numbers from the API. Story 6 is
   * explicit that sellers must not have staff exposed to unsolicited contact,
   * and publishing the number through a public query would do exactly that.
   *
   * Resolved from the already-loaded seller relation (both findById and
   * findPage include it), so this costs no additional query.
   */
  @Field()
  canReceiveInquiries: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
