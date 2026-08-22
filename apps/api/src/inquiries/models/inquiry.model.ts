import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { InquiryStatus } from '../../../generated/prisma/enums';

registerEnumType(InquiryStatus, { name: 'InquiryStatus' });

/**
 * What a buyer gets back after submitting an inquiry.
 *
 * Deliberately narrow. It carries no seller identity, no seller phone number,
 * and not even the buyer's own message echoed back. The mutation is
 * unauthenticated, so everything returned here is readable by whoever called
 * it -- and a response that included the seller's WhatsApp number would turn
 * this endpoint into a number-harvesting API, which is exactly what #91
 * story 6 exists to prevent.
 */
@ObjectType()
export class Inquiry {
  @Field(() => ID)
  id: string;

  @Field(() => InquiryStatus)
  status: InquiryStatus;

  @Field()
  createdAt: Date;

  /**
   * True only when the provider accepted the message. False covers both "not
   * delivered yet" and "delivery failed" -- the buyer is told their inquiry
   * was received either way, because it genuinely was, and a seller-side
   * configuration gap is not the buyer's problem to interpret.
   */
  @Field()
  delivered: boolean;
}
