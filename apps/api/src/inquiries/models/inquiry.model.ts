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
   * The PROVIDER ACCEPTED the message. Not the same as the seller having
   * received or read it -- Meta can accept a send and still fail to deliver
   * it to a number that is invalid, blocked, or no longer on WhatsApp.
   *
   * The UI copy is worded to match: "on its way to this seller", never "this
   * seller has your question". An earlier version claimed receipt, which the
   * schema comment on InquiryStatus.SENT had always contradicted.
   *
   * Real delivery confirmation needs Meta's delivery webhook, which is not
   * wired up -- see docs/whatsapp.md.
   */
  @Field()
  delivered: boolean;
}
