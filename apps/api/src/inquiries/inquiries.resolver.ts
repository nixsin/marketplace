import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { InquiryStatus } from '../../generated/prisma/enums';
import { CreateInquiryInput } from './dto/create-inquiry.input';
import { InquiriesService } from './inquiries.service';
import { Inquiry } from './models/inquiry.model';

@Resolver(() => Inquiry)
export class InquiriesResolver {
  constructor(private readonly inquiries: InquiriesService) {}

  /**
   * Unauthenticated on purpose: #91 story 3 wants a WhatsApp-shared link to
   * work on a cold visit with no login, and requiring an account before a
   * buyer can ask a question is exactly the friction that sends them back to
   * a competitor's phone number.
   *
   * The cost of that choice is abuse surface, handled in the service with
   * per-phone and per-phone-product limits counted from the database rather
   * than trusted to an in-process counter.
   *
   * NOTE for when login ships: this must NOT quietly become an authenticated
   * mutation. If a session exists it should be recorded alongside the
   * inquiry, but anonymous submission has to keep working.
   */
  @Mutation(() => Inquiry)
  async createInquiry(
    @Args('input') input: CreateInquiryInput,
  ): Promise<Inquiry> {
    const inquiry = await this.inquiries.create(input);
    return {
      id: inquiry.id,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
      delivered: inquiry.status === InquiryStatus.SENT,
    };
  }
}
