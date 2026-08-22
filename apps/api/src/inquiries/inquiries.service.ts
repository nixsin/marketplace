import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { InquiryStatus } from '../../generated/prisma/enums';
import { createHash, createHmac } from 'node:crypto';
import {
  INQUIRY_IP_HASH_SECRET_ENV,
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_WINDOW_MS,
  SITE_URL,
} from '@medinstru/config';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService, normalizeE164 } from './whatsapp.service';

export interface CreateInquiryArgs {
  productId: string;
  buyerName: string;
  buyerPhone: string;
  message: string;
  /** Caller's address, hashed before storage. Absent when unresolvable. */
  callerIp?: string | null;
}

/**
 * Hashed, never stored raw. A raw IP is personal data under DPDP sitting in a
 * table operators read to triage leads, and a hash still counts repeats --
 * which is all the limiter needs it for.
 */
export function hashIp(
  ip: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!ip) return null;

  // HMAC with a server-side secret, not a bare digest.
  //
  // An unkeyed SHA-256 of an IPv4 address is not the protection it looks
  // like: the input space is 2^32, small enough to enumerate outright, so
  // anyone holding this table can recover the original address by hashing
  // guesses. The key makes that impossible without also holding the secret,
  // while keeping the value deterministic, which is all the limiter needs.
  const secret = env[INQUIRY_IP_HASH_SECRET_ENV];
  if (secret) return createHmac('sha256', secret).update(ip).digest('hex');

  // No secret configured: still hashed rather than stored raw, and marked so
  // the weaker form is visible in the data rather than indistinguishable from
  // the keyed one.
  return `unkeyed:${createHash('sha256').update(ip).digest('hex')}`;
}

/**
 * Composes the message the seller receives.
 *
 * #91 story 4: the seller should know exactly which product this is about
 * without a round trip. So the body carries the product name, its id, and the
 * canonical URL -- the same URL a buyer would share, so a forwarded inquiry
 * and a forwarded link land on the same page.
 *
 * Buyer-supplied values are last and clearly labelled. They are not escaped,
 * because WhatsApp text bodies are not markup and escaping would corrupt
 * legitimate content; the protection that matters is the length cap enforced
 * at the DTO boundary.
 */
export function buildInquirySummary(input: {
  productName: string;
  productId: string;
  buyerName: string;
  buyerPhone: string;
  siteUrl?: string;
}): string {
  const base = (input.siteUrl ?? SITE_URL).replace(/\/+$/, '');
  return [
    `New inquiry via the marketplace`,
    ``,
    `Product: ${input.productName}`,
    `Ref: ${input.productId}`,
    `Link: ${base}/en/products/${input.productId}`,
    ``,
    `From: ${input.buyerName} (${input.buyerPhone})`,
  ].join('\n');
}

/**
 * The whole message as one string, for the non-template text path.
 *
 * The two halves stay separate for the TEMPLATE path, where each is its own
 * parameter: combining them meant a near-limit question lost its ending to
 * the product metadata sitting in front of it -- silently, after the API had
 * already accepted the message as valid.
 */
export function buildInquiryMessage(input: {
  productName: string;
  productId: string;
  buyerName: string;
  buyerPhone: string;
  message: string;
  siteUrl?: string;
}): string {
  return `${buildInquirySummary(input)}\n\n${input.message}`;
}

@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Records the inquiry, then attempts delivery.
   *
   * That order is the whole design. A send that fails -- bad credentials, Meta
   * outage, seller number rejected -- must still leave a lead the marketplace
   * can see and retry (#91 story 9). Sending first and persisting after would
   * mean every provider hiccup silently discards a real buyer.
   */
  async create(args: CreateInquiryArgs) {
    // Canonicalised before anything is stored, so the value written is the
    // value that can actually be sent. The form shows a spaced example
    // because that is how people write numbers; the sender needs E.164.
    const buyerPhone = normalizeE164(args.buyerPhone);
    if (!buyerPhone) {
      throw new BadRequestException(
        'Enter a valid phone number including the country code.',
      );
    }

    // Trimmed server-side, not merely in the form. The mutation is public, so
    // a direct caller can submit "  " for a name and a single space for a
    // message -- @Length(2) and @MinLength(1) both accept those -- and the
    // seller receives an inquiry with no discernible sender or question.
    const buyerName = args.buyerName.trim();
    const message = args.message.trim();
    if (!buyerName || !message) {
      throw new BadRequestException('Enter your name and a question.');
    }

    const ipHash = hashIp(args.callerIp);

    // The limit check and the insert run in ONE serializable transaction.
    // Checking and then inserting separately is a time-of-check/time-of-use
    // race: concurrent requests all read a count below the threshold and all
    // proceed, which on an unauthenticated outbound-message endpoint is
    // exactly the path worth hardening. Serializable makes the database
    // reject the loser rather than trusting application-level ordering.
    // The product and its seller are read INSIDE the transaction, and the
    // snapshot taken there is what both the insert and the send use.
    //
    // Reading them before the transaction and reusing that copy afterwards
    // meant a product reassigned in the gap would have its inquiry attributed
    // to, and DELIVERED TO, the previous seller -- handing the buyer's name,
    // phone number and question to an organisation that has nothing to do
    // with the listing. Nothing reassigns products today, which is exactly
    // why this would have gone unnoticed until something did.
    const { inquiry, product } = await this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const current = await tx.product.findUnique({
            where: { id: args.productId },
            include: { seller: true },
          });
          if (!current) {
            throw new NotFoundException(`Product ${args.productId} not found`);
          }

          await this.assertWithinRateLimit(tx, {
            buyerPhone,
            productId: args.productId,
            sellerId: current.sellerId,
            ipHash,
          });

          const created = await tx.inquiry.create({
            data: {
              productId: current.id,
              // Denormalized at inquiry time: which seller received this is a
              // historical fact and must not follow a later reassignment.
              sellerId: current.sellerId,
              buyerName,
              buyerPhone,
              message,
              ipHash,
              status: InquiryStatus.PENDING,
            },
          });

          return { inquiry: created, product: current };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    const sellerNumber = product.seller.whatsappNumber;
    if (!sellerNumber) {
      // A seller with no number is a configuration state, not a buyer error.
      // The lead is captured and can be delivered once the seller is
      // onboarded, so this must not surface as a failed request.
      return this.markFailed(inquiry, 'seller has no WhatsApp number');
    }

    const result = await this.whatsapp.sendInquiry(sellerNumber, {
      summary: buildInquirySummary({
        productName: product.name,
        productId: product.id,
        buyerName,
        buyerPhone,
      }),
      // The buyer's own words, kept as their own template parameter so they
      // are never truncated by metadata in front of them.
      buyerMessage: message,
    });

    if (!result.ok) {
      this.logger.warn(
        `Inquiry ${inquiry.id} recorded but not delivered: ${result.reason}`,
      );
      return this.markFailed(inquiry, result.reason);
    }

    // The provider has ALREADY accepted the message at this point. If
    // recording that fact fails, the send still happened -- so surfacing the
    // write error as a GraphQL failure would tell the buyer their inquiry did
    // not go through and invite a retry that sends the seller a duplicate.
    //
    // The row is left PENDING and the discrepancy logged loudly with the
    // provider's message id, which is what an operator needs to reconcile it.
    // A stuck PENDING row is a visible, fixable inconsistency; a duplicate
    // WhatsApp message to a real seller is not.
    try {
      return await this.prisma.inquiry.update({
        where: { id: inquiry.id },
        data: {
          status: InquiryStatus.SENT,
          providerMessageId: result.providerMessageId,
        },
      });
    } catch (error) {
      this.logger.error(
        `Inquiry ${inquiry.id} was DELIVERED (provider id ` +
          `${result.providerMessageId ?? 'unknown'}) but could not be marked ` +
          `SENT; it remains PENDING and needs reconciling: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return inquiry;
    }
  }

  /**
   * Records a delivery failure, and cannot itself fail the mutation.
   *
   * The SENT path was already defensive about this; the FAILED path was not,
   * which is a difference with no justification. The inquiry is ALREADY
   * persisted by the time either runs, so letting a transient database error
   * escape tells the buyer their submission failed and invites them to
   * resubmit something already recorded.
   */
  private async markFailed<T extends { id: string }>(
    inquiry: T,
    reason: string,
  ): Promise<T> {
    try {
      return (await this.updateFailed(inquiry.id, reason)) as unknown as T;
    } catch (error) {
      this.logger.error(
        `Inquiry ${inquiry.id} could not be marked FAILED (${reason}); it ` +
          `remains PENDING and needs reconciling: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
      // The row that WAS persisted, with what we know applied in memory.
      // Returning null would push the failure onto the caller, which is the
      // very thing this catch exists to prevent; re-reading from the database
      // that just failed is no more likely to work.
      return {
        ...inquiry,
        status: InquiryStatus.FAILED,
        failureReason: reason.slice(0, 500),
      };
    }
  }

  private updateFailed(id: string, reason: string) {
    return this.prisma.inquiry.update({
      where: { id },
      // Truncated because this is provider-supplied text on a column an
      // operator reads, not a place to accumulate arbitrary length.
      data: {
        status: InquiryStatus.FAILED,
        failureReason: reason.slice(0, 500),
      },
    });
  }

  /**
   * Two limits, because they stop different abuses.
   *
   * Per-phone caps a scripted caller blasting many sellers. Per-phone-product
   * stops the narrower nuisance of one buyer repeatedly messaging one seller
   * about one item, which the broader limit alone would permit right up to
   * its ceiling.
   *
   * Counted from the Inquiry table rather than held in memory on purpose: an
   * in-process counter resets on deploy and is per-instance, so it would be
   * defeated by a restart or by horizontal scaling. Both index reads are
   * covered by (buyerPhone, createdAt) and (productId, createdAt).
   */
  /**
   * Retries a transaction the database aborted for serialization reasons.
   *
   * Serializable isolation does not queue conflicting transactions, it aborts
   * one of them -- Prisma surfaces that as P2034. Without this, two buyers
   * submitting at the same instant meant one of them received an internal
   * error instead of either succeeding or being told about the rate limit.
   * The conflict is the database doing its job; the caller should never see
   * it.
   *
   * Only P2034 is retried. Any other failure, including the rate-limit
   * rejection itself, propagates immediately -- retrying a BadRequest would
   * turn a deliberate refusal into three of them.
   */
  private async withSerializationRetry<T>(
    run: () => Promise<T>,
    attempts = 3,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const isConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!isConflict || attempt >= attempts) throw error;
        this.logger.warn(
          `Serialization conflict on inquiry write, retrying (${attempt}/${attempts - 1})`,
        );
      }
    }
  }

  /**
   * Four limits, because they fail in different ways.
   *
   * The two phone limits are keyed on a value the CALLER TYPES, so on their
   * own they are defeated by rotating E.164 numbers -- which, on an
   * unauthenticated endpoint that emits outbound WhatsApp messages, made them
   * decorative rather than protective. They stay because they give a real
   * buyer sane feedback, not because they stop an attacker.
   *
   * The IP limit adds a dimension the caller does not choose freely. It is
   * not unforgeable -- proxies exist -- but it raises cost from "change a
   * form field" to "acquire addresses".
   *
   * The per-seller cap is the one that still holds when both of the above are
   * rotated, so it is what actually bounds how much spam a seller can be made
   * to receive. Nothing here is a substitute for CAPTCHA or verified phone
   * numbers; it is defence in depth in front of them.
   *
   * Takes the transaction client so the counts and the insert are one atomic
   * unit -- see the caller.
   */
  private async assertWithinRateLimit(
    tx: Prisma.TransactionClient,
    keys: {
      buyerPhone: string;
      productId: string;
      sellerId: string;
      ipHash: string | null;
    },
  ) {
    const since = new Date(Date.now() - INQUIRY_RATE_LIMIT_WINDOW_MS);
    const { buyerPhone, productId, sellerId, ipHash } = keys;

    const [fromPhone, forThisProduct, fromIp, forSeller] = await Promise.all([
      tx.inquiry.count({ where: { buyerPhone, createdAt: { gte: since } } }),
      tx.inquiry.count({
        where: { buyerPhone, productId, createdAt: { gte: since } },
      }),
      // Skipped when the address could not be resolved: counting every
      // unresolvable caller as one bucket would let one of them lock out all
      // the others.
      ipHash
        ? tx.inquiry.count({ where: { ipHash, createdAt: { gte: since } } })
        : Promise.resolve(0),
      tx.inquiry.count({ where: { sellerId, createdAt: { gte: since } } }),
    ]);

    if (forSeller >= INQUIRY_RATE_LIMIT_PER_SELLER) {
      // Deliberately vague to the caller. Telling them a seller's cap is full
      // hands an attacker a progress indicator for the one limit they cannot
      // rotate around.
      throw new BadRequestException(
        'Too many inquiries right now. Please try again later.',
      );
    }
    if (fromIp >= INQUIRY_RATE_LIMIT_PER_IP) {
      throw new BadRequestException(
        'Too many inquiries from this network recently. Please try again later.',
      );
    }
    if (fromPhone >= INQUIRY_RATE_LIMIT_PER_PHONE) {
      throw new BadRequestException(
        'Too many inquiries from this number recently. Please try again later.',
      );
    }
    if (forThisProduct >= INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT) {
      throw new BadRequestException(
        'You have already sent inquiries about this product recently.',
      );
    }
  }
}
