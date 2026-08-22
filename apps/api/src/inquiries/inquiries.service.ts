import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { InquiryStatus } from '../../generated/prisma/enums';
import { createHash } from 'node:crypto';
import {
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_WINDOW_MS,
  SITE_URL,
} from '@medinstru/config';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';

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
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex');
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
export function buildInquiryMessage(input: {
  productName: string;
  productId: string;
  buyerName: string;
  buyerPhone: string;
  message: string;
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
    ``,
    input.message,
  ].join('\n');
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
    const product = await this.prisma.product.findUnique({
      where: { id: args.productId },
      include: { seller: true },
    });

    if (!product) {
      throw new NotFoundException(`Product ${args.productId} not found`);
    }

    const ipHash = hashIp(args.callerIp);

    // The limit check and the insert run in ONE serializable transaction.
    // Checking and then inserting separately is a time-of-check/time-of-use
    // race: concurrent requests all read a count below the threshold and all
    // proceed, which on an unauthenticated outbound-message endpoint is
    // exactly the path worth hardening. Serializable makes the database
    // reject the loser rather than trusting application-level ordering.
    const inquiry = await this.prisma.$transaction(
      async (tx) => {
        await this.assertWithinRateLimit(tx, {
          buyerPhone: args.buyerPhone,
          productId: args.productId,
          sellerId: product.sellerId,
          ipHash,
        });

        return tx.inquiry.create({
          data: {
            productId: product.id,
            // Denormalized at inquiry time: which seller received this is a
            // historical fact and must not follow a later reassignment.
            sellerId: product.sellerId,
            buyerName: args.buyerName,
            buyerPhone: args.buyerPhone,
            message: args.message,
            ipHash,
            status: InquiryStatus.PENDING,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const sellerNumber = product.seller.whatsappNumber;
    if (!sellerNumber) {
      // A seller with no number is a configuration state, not a buyer error.
      // The lead is captured and can be delivered once the seller is
      // onboarded, so this must not surface as a failed request.
      return this.markFailed(inquiry.id, 'seller has no WhatsApp number');
    }

    const result = await this.whatsapp.sendInquiry(
      sellerNumber,
      buildInquiryMessage({
        productName: product.name,
        productId: product.id,
        buyerName: args.buyerName,
        buyerPhone: args.buyerPhone,
        message: args.message,
      }),
    );

    if (!result.ok) {
      this.logger.warn(
        `Inquiry ${inquiry.id} recorded but not delivered: ${result.reason}`,
      );
      return this.markFailed(inquiry.id, result.reason);
    }

    return this.prisma.inquiry.update({
      where: { id: inquiry.id },
      data: {
        status: InquiryStatus.SENT,
        providerMessageId: result.providerMessageId,
      },
    });
  }

  private markFailed(id: string, reason: string) {
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
