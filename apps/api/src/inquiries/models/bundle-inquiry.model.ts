import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * What a buyer gets back after submitting a shortlist.
 *
 * As narrow as the single-inquiry result, and for the same reason: this
 * mutation is unauthenticated, so anything returned is readable by whoever
 * called it. No seller identity, no seller number, no echo of the message.
 */
@ObjectType()
export class BundleInquiryResult {
  /** Groups the rows this submission created. */
  @Field(() => ID)
  bundleId: string;

  /** How many products the inquiry actually covered. */
  // Int, not the Float that a bare @Field() infers from `number`: a count of
  // products is never fractional, and a Float here would leak that sloppiness
  // into every generated client type.
  @Field(() => Int)
  productCount: number;

  /**
   * Products left out because this buyer already asked about them too
   * recently. Returned so the UI can say "sent for 18 of 20" rather than
   * silently dropping items the buyer deliberately selected.
   */
  @Field(() => [ID])
  skippedProductIds: string[];

  /**
   * How many sellers this shortlist reached. A catalogue selection spans
   * sellers, so one submission can become several messages -- the buyer is
   * told how many, because "sent to 3 sellers" sets a different expectation
   * about replies than "sent".
   */
  @Field(() => Int)
  sellerCount: number;

  /**
   * True only when EVERY seller's message was accepted. Partial delivery is
   * reported as false rather than true-ish: telling a buyer it worked when
   * one seller never received it is the failure mode worth avoiding, and
   * sellerCount is there for the UI to be more specific if it wants.
   */
  @Field()
  delivered: boolean;
}
