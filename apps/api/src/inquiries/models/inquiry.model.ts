import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { InquiryStatus } from '../../../generated/prisma/enums';

registerEnumType(InquiryStatus, { name: 'InquiryStatus' });

/**
 * What a buyer gets back after submitting an inquiry.
 *
 * Deliberately narrow. It carries no seller identity, no seller contact
 * details, and no echo of the buyer's own message. The mutation is
 * unauthenticated, so everything returned here is readable by whoever called
 * it -- and a response that included the seller's number would turn this
 * endpoint into a contact-harvesting API, which is exactly what #91 story 6
 * exists to prevent.
 *
 * There is no `delivered` field, because nothing delivers yet. Adding one now
 * would mean shipping a boolean that is always false and copy that has to
 * pretend otherwise; it lands with the delivery change.
 */
@ObjectType()
export class Inquiry {
  @Field(() => ID)
  id: string;

  @Field(() => InquiryStatus)
  status: InquiryStatus;

  @Field()
  createdAt: Date;
}
