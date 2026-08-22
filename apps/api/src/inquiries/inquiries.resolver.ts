import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { InquiryStatus } from '../../generated/prisma/enums';
import { CreateBundleInquiryInput } from './dto/create-bundle-inquiry.input';
import { CreateInquiryInput } from './dto/create-inquiry.input';
import { InquiriesService } from './inquiries.service';
import { BundleInquiryResult } from './models/bundle-inquiry.model';
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

  /**
   * One inquiry covering several shortlisted products.
   *
   * Unauthenticated for the same reason as the single-product mutation, and
   * rate-limited by SUBMISSION rather than by row -- otherwise a shortlist
   * would burn a buyer's whole hourly budget in one action while five
   * separate single inquiries would not.
   */
  @Mutation(() => BundleInquiryResult)
  async createBundleInquiry(
    @Args('input') input: CreateBundleInquiryInput,
  ): Promise<BundleInquiryResult> {
    const result = await this.inquiries.createBundle(input);
    return {
      bundleId: result.bundleId,
      productCount: result.inquiries.length,
      skippedProductIds: result.skippedProductIds,
      // One message covers the whole shortlist, so every row shares a
      // delivery state; reading the first is reading all of them.
      delivered: result.inquiries[0]?.status === InquiryStatus.SENT,
    };
  }
}
