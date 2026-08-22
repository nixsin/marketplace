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
 * There is STILL no `delivered` field, and that is deliberate for one more
 * change. This one makes delivery real -- rows now reach SENT and FAILED, and
 * a seller's phone actually rings -- but reporting that outcome to the buyer
 * is its own change, because the confirmation copy is the single highest-risk
 * part of this feature: three separate review rounds on the unsplit version
 * were about copy claiming more than the API knew.
 *
 * Until then the buyer is told their inquiry was recorded, which stays true
 * whether or not the send succeeded. Under-claiming is the safe direction.
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
