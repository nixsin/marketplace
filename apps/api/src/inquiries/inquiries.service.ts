import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InquiryStatus } from '../../generated/prisma/enums';
import {
  INQUIRY_BULK_MAX_PRODUCTS,
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

export interface CreateBundleArgs {
  productIds: string[];
  buyerName: string;
  buyerPhone: string;
  message: string;
}

interface ProductForInquiry {
  id: string;
  name: string;
  sellerId: string;
  seller: { whatsappNumber: string | null };
}

/**
 * Composes the message the seller receives.
 *
 * Takes a LIST because a buyer can shortlist several products and send one
 * inquiry covering all of them -- a seller should see everything they can
 * quote in a single message, not one message per item to reassemble.
 *
 * #91 story 4: each entry carries the product name, its id and the canonical
 * URL, so a forwarded inquiry and a forwarded link land on the same page.
 *
 * Buyer-supplied values are last and clearly labelled. They are not escaped:
 * WhatsApp text bodies are not markup, so escaping would corrupt legitimate
 * content. The cap that matters is the length limit at the DTO boundary.
 */
export function buildInquiryMessage(input: {
  products: { id: string; name: string }[];
  buyerName: string;
  buyerPhone: string;
  message: string;
  siteUrl?: string;
}): string {
  const base = (input.siteUrl ?? SITE_URL).replace(/\/+$/, '');
  const single = input.products.length === 1;

  const lines: string[] = [
    single
      ? 'New inquiry via the marketplace'
      : `New inquiry via the marketplace (${input.products.length} products)`,
    '',
  ];

  input.products.forEach((product, index) => {
    // Numbered only when there is more than one, so a single-product inquiry
    // does not read as an oddly formatted list of one.
    lines.push(
      single ? `Product: ${product.name}` : `${index + 1}. ${product.name}`,
      `   Ref: ${product.id}`,
      `   ${base}/en/products/${product.id}`,
      '',
    );
  });

  lines.push(
    `From: ${input.buyerName} (${input.buyerPhone})`,
    '',
    input.message,
  );
  return lines.join('\n');
}

@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** A single-product inquiry is a bundle of one -- there is no second path. */
  async create(args: CreateInquiryArgs) {
    const result = await this.createBundle({
      productIds: [args.productId],
      buyerName: args.buyerName,
      buyerPhone: args.buyerPhone,
      message: args.message,
    });
    // createBundle either returns at least one row or throws.
    return result.inquiries[0];
  }

  /**
   * One inquiry covering several shortlisted products, fanned out per seller.
   *
   * A catalogue shortlist spans sellers, and the buyer neither knows nor
   * should need to know who owns what -- the cards show a seller NAME, never
   * an id. So the grouping happens here: each seller receives ONE message
   * listing only their own items, and the buyer performs one action and gets
   * one confirmation.
   *
   * Sending the whole shortlist to a single seller would hand them a list of
   * a competitor's products; sending one message per product would make a
   * seller reassemble a five-message thread. Per-seller is the only grouping
   * that is correct for both sides.
   *
   * Delivery is per group, so one seller's failure cannot mark another
   * seller's rows failed -- a bad number on one org must not make the buyer
   * think nothing was delivered.
   *
   * Records before sending, for the same reason the single path does: a
   * provider failure must leave a retryable row, never a discarded buyer.
   */
  async createBundle(args: CreateBundleArgs) {
    // Deduped first: a UI that lets the same card be added twice must not
    // produce two rows, two rate-limit hits and a duplicated message line.
    const productIds = [...new Set(args.productIds)];

    if (productIds.length === 0) {
      throw new BadRequestException('Select at least one product.');
    }
    if (productIds.length > INQUIRY_BULK_MAX_PRODUCTS) {
      throw new BadRequestException(
        `Select at most ${INQUIRY_BULK_MAX_PRODUCTS} products.`,
      );
    }

    const products = (await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { seller: true },
    })) as unknown as ProductForInquiry[];

    if (products.length !== productIds.length) {
      const found = new Set(products.map((p) => p.id));
      const missing = productIds.filter((id) => !found.has(id));
      throw new NotFoundException(`Product ${missing[0]} not found`);
    }

    await this.assertBundleWithinLimit(args.buyerPhone);

    // Products this buyer has already asked about too recently. Dropped
    // rather than failing the whole submission: rejecting a 20-item shortlist
    // because one item was asked about an hour ago is a worse outcome than
    // sending the other 19 and saying so.
    const skippedProductIds = await this.findProductsAtLimit(
      args.buyerPhone,
      productIds,
    );
    const eligible = products.filter((p) => !skippedProductIds.includes(p.id));

    if (eligible.length === 0) {
      throw new BadRequestException(
        'You have already sent inquiries about these products recently.',
      );
    }

    // One id shared by every row this submission creates. The buyer performed
    // one action, and that is what this records -- per-product rows keep
    // per-product analytics and limits working, while this preserves the fact
    // that they were asked together.
    const bundleId = randomUUID();

    // PERSIST FIRST, then send. An earlier version of this refactor computed
    // the delivery outcome first so it could be written once at insert time,
    // which silently inverted the order the single-product path had always
    // used -- and a provider failure would have discarded the buyer entirely.
    // A test asserting the sequence caught it. Do not "simplify" this back
    // into one write.
    await this.prisma.inquiry.createMany({
      data: eligible.map((product) => ({
        bundleId,
        productId: product.id,
        // Denormalized at inquiry time: which seller received this is a
        // historical fact and must not follow a later reassignment.
        sellerId: product.sellerId,
        buyerName: args.buyerName,
        buyerPhone: args.buyerPhone,
        message: args.message,
        status: InquiryStatus.PENDING,
      })),
    });

    // FAN OUT. One message per seller, covering only that seller's items.
    const bySeller = new Map<string, ProductForInquiry[]>();
    for (const product of eligible) {
      const group = bySeller.get(product.sellerId) ?? [];
      group.push(product);
      bySeller.set(product.sellerId, group);
    }

    let deliveredSellers = 0;
    for (const [sellerId, sellerProducts] of bySeller) {
      const outcome = await this.deliver({
        products: sellerProducts,
        buyerName: args.buyerName,
        buyerPhone: args.buyerPhone,
        message: args.message,
      });

      if (outcome.status === InquiryStatus.SENT) deliveredSellers += 1;

      // Scoped to (bundle, seller), NOT the whole bundle. Updating by
      // bundleId alone would let one seller's failure overwrite another
      // seller's successful delivery -- the rows would then claim nothing
      // arrived when most of it did.
      await this.prisma.inquiry.updateMany({
        where: { bundleId, sellerId },
        data: {
          status: outcome.status,
          providerMessageId: outcome.providerMessageId,
          failureReason: outcome.failureReason,
        },
      });
    }

    const inquiries = await this.prisma.inquiry.findMany({
      where: { bundleId },
      orderBy: { productId: 'asc' },
    });

    return {
      bundleId,
      inquiries,
      skippedProductIds,
      sellerCount: bySeller.size,
      deliveredSellerCount: deliveredSellers,
    };
  }

  /**
   * Sends ONE seller their slice of the shortlist and returns the outcome,
   * rather than writing rows itself, so the caller can apply one delivery
   * result to that seller's rows. One message about three products must not
   * report three different delivery states -- and equally, one seller's
   * failure must not touch another seller's rows.
   */
  private async deliver(input: {
    products: ProductForInquiry[];
    buyerName: string;
    buyerPhone: string;
    message: string;
  }): Promise<{
    status: InquiryStatus;
    providerMessageId: string | null;
    failureReason: string | null;
  }> {
    const sellerNumber = input.products[0].seller.whatsappNumber;

    if (!sellerNumber) {
      // A seller with no number is a configuration state, not a buyer error.
      // The leads are captured and deliverable once they are onboarded.
      return {
        status: InquiryStatus.FAILED,
        providerMessageId: null,
        failureReason: 'seller has no WhatsApp number',
      };
    }

    const result = await this.whatsapp.sendText(
      sellerNumber,
      buildInquiryMessage({
        products: input.products,
        buyerName: input.buyerName,
        buyerPhone: input.buyerPhone,
        message: input.message,
      }),
    );

    if (!result.ok) {
      this.logger.warn(
        `Inquiry covering ${input.products.length} product(s) recorded but not delivered: ${result.reason}`,
      );
      return {
        status: InquiryStatus.FAILED,
        providerMessageId: null,
        // Truncated: provider-supplied text on a column an operator reads,
        // not a place to accumulate arbitrary length.
        failureReason: result.reason.slice(0, 500),
      };
    }

    return {
      status: InquiryStatus.SENT,
      providerMessageId: result.providerMessageId,
      failureReason: null,
    };
  }

  /**
   * Caps SUBMISSIONS per phone, not rows.
   *
   * Counting rows would tie the limit to shortlist size: one 6-item shortlist
   * would exhaust a 5-per-hour budget in a single action, while five separate
   * single inquiries would not -- for more buyer decisions and more outbound
   * messages. Distinct bundles is what actually corresponds to "how many
   * times did this person contact a seller".
   *
   * Counted from the database rather than an in-process counter, which resets
   * on deploy and is per-instance, so a restart or a second replica defeats it.
   */
  private async assertBundleWithinLimit(buyerPhone: string) {
    const since = new Date(Date.now() - INQUIRY_RATE_LIMIT_WINDOW_MS);
    const bundles = await this.prisma.inquiry.findMany({
      where: { buyerPhone, createdAt: { gte: since } },
      select: { bundleId: true },
      distinct: ['bundleId'],
    });

    if (bundles.length >= INQUIRY_RATE_LIMIT_PER_PHONE) {
      throw new BadRequestException(
        'Too many inquiries from this number recently. Please try again later.',
      );
    }
  }

  /** Products this phone has already asked about too many times in the window. */
  private async findProductsAtLimit(
    buyerPhone: string,
    productIds: string[],
  ): Promise<string[]> {
    const since = new Date(Date.now() - INQUIRY_RATE_LIMIT_WINDOW_MS);
    const recent = await this.prisma.inquiry.groupBy({
      by: ['productId'],
      where: {
        buyerPhone,
        productId: { in: productIds },
        createdAt: { gte: since },
      },
      _count: { productId: true },
    });

    return recent
      .filter(
        (row) => row._count.productId >= INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
      )
      .map((row) => row.productId);
  }
}
