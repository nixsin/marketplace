import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { InquiryStatus } from '../../generated/prisma/enums';
import { createHmac } from 'node:crypto';
import {
  INQUIRY_IP_HASH_SECRET_ENV,
  INQUIRY_SUMMARY_NAME_MAX_LENGTH,
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_WINDOW_MS,
  SITE_URL,
} from '@medinstru/config';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService, normalizeE164 } from './whatsapp.service';

/** What insertInquiry hands back: the new row plus the snapshot it was built from. */
type InsertedInquiry = {
  inquiry: Prisma.InquiryGetPayload<object>;
  product: Prisma.ProductGetPayload<{ include: { seller: true } }>;
};

export interface CreateInquiryArgs {
  /** Stable per-submission key; the same value on every retry. */
  idempotencyKey: string;
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
/**
 * Shorter than this and the key is guessable, which puts us back where an
 * unkeyed digest was. Rejecting it is better than pretending.
 */
const MIN_IP_HASH_SECRET_LENGTH = 16;

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
  // NO SECRET means NO STORAGE, not a weaker hash.
  //
  // An unkeyed SHA-256 of an IPv4 address is reversible by anyone holding the
  // table: 2^32 is small enough to enumerate outright. Prefixing it
  // "unkeyed:" labelled the weakness without removing it -- the personal data
  // was still recoverable. Declining to store anything is the only honest
  // option, and the limiter already skips a null bucket, so the per-IP limit
  // simply does not run rather than running on a reversible digest.
  const secret = env[INQUIRY_IP_HASH_SECRET_ENV];
  if (!secret || secret.length < MIN_IP_HASH_SECRET_LENGTH) return null;

  return createHmac('sha256', secret).update(ip).digest('hex');
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

  // CONTACT FIRST, and the product name bounded.
  //
  // The From line used to come last, and sanitizeTemplateParam truncates from
  // the end. Product names are unbounded `String` in the schema -- the seeded
  // catalogue already has a deliberately absurd one -- so a long enough name
  // pushed the buyer's name and phone number off the end entirely. The seller
  // would receive an inquiry with no way to reply to it, which is worse than
  // receiving nothing at all: it looks answerable and is not.
  //
  // Ordering alone would be enough to protect the contact line, but the name
  // is bounded too so the whole summary fits deterministically rather than
  // relying on nothing after it mattering.
  const name =
    input.productName.length > INQUIRY_SUMMARY_NAME_MAX_LENGTH
      ? `${input.productName.slice(0, INQUIRY_SUMMARY_NAME_MAX_LENGTH - 1)}\u2026`
      : input.productName;

  return [
    `New inquiry via the marketplace`,
    ``,
    `From: ${input.buyerName} (${input.buyerPhone})`,
    ``,
    `Product: ${name}`,
    `Ref: ${input.productId}`,
    `Link: ${base}/en/products/${input.productId}`,
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

/**
 * Makes provider-supplied text safe to put in a log line.
 *
 * Meta's error.message is external input. Newlines let it forge log entries
 * that look like they came from us, and an unbounded value inflates log
 * volume. The 500-character truncation on the database column happened AFTER
 * the log call, so it protected the wrong thing.
 */
export function sanitizeForLog(value: string, max = 200): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\p{Cc}/gu, '');
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
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
  // Return type stated, not inferred. Its branches -- the idempotency hit,
  // the collision winner, the insert, and both markFailed paths -- inferred
  // to `any` together, which propagated untyped values all the way into the
  // resolver and every log line built from them.
  async create(
    args: CreateInquiryArgs,
  ): Promise<Prisma.InquiryGetPayload<object>> {
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
    // The DTO's @Length(2) runs against the UNTRIMMED value, so " A " passed
    // it and was then stored as "A". The bound has to be re-applied to what
    // is actually kept.
    if (buyerName.length < 2 || !message) {
      throw new BadRequestException('Enter your name and a question.');
    }

    // Already submitted? Return the SAME inquiry rather than creating another.
    //
    // A lost response is indistinguishable from a failed one, so a buyer or a
    // script retrying is expected -- and without this each retry would create
    // a row and send the seller another WhatsApp message. The unique index on
    // idempotencyKey is what actually enforces this; the lookup just avoids
    // the round trip in the common case.
    const existing = await this.prisma.inquiry.findUnique({
      where: { idempotencyKey: args.idempotencyKey },
    });
    if (existing) return existing;

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
    // P2002 means the idempotency key collided: two requests both passed the
    // findUnique above before either inserted, and this one lost the race.
    // The winner's row IS the correct response -- returning an error here
    // would tell a buyer their inquiry failed when it demonstrably succeeded,
    // and invite the retry idempotency exists to make safe.
    //
    // An earlier version rethrew, directly contradicting the comment sitting
    // next to it, and the test codified the rejection as intended behaviour.
    let created: InsertedInquiry;
    try {
      created = await this.insertInquiry({
        idempotencyKey: args.idempotencyKey,
        productId: args.productId,
        buyerName,
        buyerPhone,
        message,
        ipHash,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.inquiry.findUnique({
          where: { idempotencyKey: args.idempotencyKey },
        });
        if (winner) return winner;
      }
      throw error;
    }
    const { inquiry, product } = created;

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
      const reason = sanitizeForLog(result.reason);

      if (result.ambiguous) {
        // The request may have reached Meta before the response was lost, so
        // this is NOT a failure. Left PENDING: a FAILED row invites a retry
        // that double-messages the seller, while PENDING says exactly what is
        // true -- we do not know.
        //
        // TODO(#151): reconcile ambiguous PENDING rows via a delivery
        // webhook. Nothing resolves one today, so it stays PENDING forever.
        //
        // FREQUENCY: requires a provider timeout or dropped connection, which
        // cannot occur at all until Meta credentials exist. Zero today.
        //
        // FIX WHEN TOUCHED: a delivery webhook keyed on providerMessageId,
        // which is already stored for exactly this purpose.
        this.logger.warn(
          `Inquiry ${inquiry.id} has an AMBIGUOUS provider outcome, left ` +
            `PENDING rather than FAILED: ${reason}`,
        );
        return inquiry;
      }

      this.logger.warn(
        `Inquiry ${inquiry.id} recorded but not delivered: ${reason}`,
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
    //
    // TODO(#151): sweep rows stuck PENDING after an accepted send.
    // Reconciliation is manual today; nothing sweeps them.
    //
    // FREQUENCY: requires a database failure in the window between an
    // accepted send and its status write -- milliseconds, and only while the
    // provider is configured at all.
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
          `${sanitizeForLog(result.providerMessageId ?? 'unknown', 64)}) but ` +
          `could not be marked SENT; it remains PENDING and needs ` +
          `reconciling: ` +
          `${sanitizeForLog(error instanceof Error ? error.message : 'unknown error')}`,
      );
      // Returned marked SENT even though the row is not, mirroring what the
      // FAILED path already does. Meta ACCEPTED this message; returning the
      // untouched PENDING row made the resolver report delivered:false and
      // show the buyer "we couldn't reach the seller, try another way" for a
      // message that had in fact arrived. The database inconsistency is real
      // and logged for reconciliation, but the buyer should be told what
      // actually happened, not what the failed write recorded.
      return {
        ...inquiry,
        status: InquiryStatus.SENT,
        providerMessageId: result.providerMessageId,
      };
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
  private async markFailed(
    inquiry: Prisma.InquiryGetPayload<object>,
    reason: string,
  ): Promise<Prisma.InquiryGetPayload<object>> {
    try {
      return await this.updateFailed(inquiry.id, reason);
    } catch (error) {
      this.logger.error(
        `Inquiry ${inquiry.id} could not be marked FAILED ` +
          `(${sanitizeForLog(reason)}); it remains PENDING and needs ` +
          `reconciling: ` +
          `${sanitizeForLog(error instanceof Error ? error.message : 'unknown error')}`,
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
  private async insertInquiry(args: {
    idempotencyKey: string;
    productId: string;
    buyerName: string;
    buyerPhone: string;
    message: string;
    ipHash: string | null;
    // Return type stated explicitly: $transaction's generic widens to `any`
    // through withSerializationRetry, which then propagates untyped values
    // into the caller and every log line built from them.
  }): Promise<InsertedInquiry> {
    const { buyerName, buyerPhone, message, ipHash } = args;
    return this.withSerializationRetry(() =>
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
              idempotencyKey: args.idempotencyKey,
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
  }

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
