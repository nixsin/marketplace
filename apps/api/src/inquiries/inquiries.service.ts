import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InquiryStatus } from '../../generated/prisma/enums';
import {
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
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

    await this.assertWithinRateLimit(args.buyerPhone, args.productId);

    const inquiry = await this.prisma.inquiry.create({
      data: {
        productId: product.id,
        // Denormalized at inquiry time: which seller received this is a
        // historical fact and must not follow a later product reassignment.
        sellerId: product.sellerId,
        buyerName: args.buyerName,
        buyerPhone: args.buyerPhone,
        message: args.message,
        status: InquiryStatus.PENDING,
      },
    });

    const sellerNumber = product.seller.whatsappNumber;
    if (!sellerNumber) {
      // A seller with no number is a configuration state, not a buyer error.
      // The lead is captured and can be delivered once the seller is
      // onboarded, so this must not surface as a failed request.
      return this.markFailed(inquiry.id, 'seller has no WhatsApp number');
    }

    const result = await this.whatsapp.sendText(
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
  private async assertWithinRateLimit(buyerPhone: string, productId: string) {
    const since = new Date(Date.now() - INQUIRY_RATE_LIMIT_WINDOW_MS);

    const [fromPhone, forThisProduct] = await Promise.all([
      this.prisma.inquiry.count({
        where: { buyerPhone, createdAt: { gte: since } },
      }),
      this.prisma.inquiry.count({
        where: { buyerPhone, productId, createdAt: { gte: since } },
      }),
    ]);

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
