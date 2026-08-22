import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  INQUIRY_IP_HASH_SECRET_ENV,
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_WINDOW_MS,
} from '@medinstru/config';
import { Prisma } from '../../generated/prisma/client';
import { InquiryStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeE164 } from './phone';

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
 * Shorter than this and the key is guessable, which puts us back where an
 * unkeyed digest was.
 */
const MIN_IP_HASH_SECRET_LENGTH = 16;

/**
 * Keyed HMAC of an address, or nothing at all.
 *
 * An UNKEYED SHA-256 of an IPv4 address is not protection: the input space is
 * 2^32, small enough to enumerate outright, so anyone holding this table
 * recovers the address by hashing guesses. Labelling such a value "unkeyed"
 * would advertise the weakness without removing it.
 *
 * So without a usable secret nothing is stored and the per-IP limit simply
 * does not run -- the limiter skips a null bucket by design. A raw address is
 * personal data under DPDP sitting in a table operators read to triage leads;
 * a keyed hash still counts repeats, which is all the limiter needs.
 */
export function hashIp(
  ip: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!ip) return null;
  const secret = env[INQUIRY_IP_HASH_SECRET_ENV];
  if (!secret || secret.length < MIN_IP_HASH_SECRET_LENGTH) return null;
  return createHmac('sha256', secret).update(ip).digest('hex');
}

/** The fields that make one submission distinct from another. */
export interface SubmissionIdentity {
  productId: string;
  buyerName: string;
  buyerPhone: string;
  message: string;
}

/**
 * Compared explicitly rather than by walking the argument's own keys.
 *
 * Deriving the list from the caller's object made the check depend on what
 * that caller happened to pass: insertInquiry hands it the full insert args,
 * so ipHash joined the comparison and a genuine retry from a different
 * address was rejected as an edit. A fixed list cannot be widened by a call
 * site, and adding a field here is a deliberate act with a test to match.
 */
const SUBMISSION_FIELDS = [
  'productId',
  'buyerName',
  'buyerPhone',
  'message',
] as const;

/**
 * A reused idempotency key must carry the SAME submission, or it is not a
 * retry of anything.
 *
 * Returning the stored row for a key without checking what it holds loses
 * real data silently, and it was reproduced end to end before this existed:
 * submit a question, lose the response, correct the phone number and the
 * wording, submit again -- and the API answers with the ORIGINAL row's id
 * while the confirmation tells the buyer their edited inquiry was recorded.
 * It never was. The seller has the first version and the buyer's corrected
 * number is gone, with nothing anywhere reporting a problem.
 *
 * The same shape, from a different direction: the DTO permits an 8-character
 * key, so two anonymous callers can choose the same one. Without this check
 * the second caller's lead is silently discarded and they are told it
 * succeeded.
 *
 * Compared against the row's own columns rather than a stored fingerprint --
 * no migration, and it compares what was actually written instead of a hash
 * of what we believed we wrote. Rejecting is the honest answer: the request
 * asks to record something that is not what this key already means. The web
 * client never provokes it, because it mints a new key the moment the buyer
 * edits anything.
 */
export function assertSameSubmission<T extends SubmissionIdentity>(
  existing: T,
  submission: SubmissionIdentity,
): T {
  const changed = SUBMISSION_FIELDS.some(
    (field) => existing[field] !== submission[field],
  );
  if (changed) {
    // Names no stored value. The key can be chosen by the caller, so echoing
    // what it currently holds would let anyone read back someone else's
    // inquiry by guessing keys.
    throw new BadRequestException(
      'This submission was already sent with different details. Reload the page and try again.',
    );
  }
  return existing;
}

@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a buyer's inquiry. Nothing is delivered here.
   *
   * The lead is captured and readable; sending it to the seller is a separate
   * change. Recording first is not a staging convenience -- it is the order
   * the delivered feature keeps, because a provider failure must leave a row
   * an operator can retry from rather than a silently discarded buyer.
   */
  async create(args: CreateInquiryArgs) {
    // Canonicalised before anything is stored or counted. The form shows a
    // spaced example because that is how people write numbers; storing it
    // that way would make one number three rate-limit buckets.
    const buyerPhone = normalizeE164(args.buyerPhone);
    if (!buyerPhone) {
      throw new BadRequestException(
        'Enter a valid phone number including the country code.',
      );
    }

    // Trimmed server-side, not merely in the form. The mutation is public, so
    // a direct caller can submit "  " for a name and a single space for a
    // message -- @Length(2) accepts the former and @MinLength(1) the latter --
    // and the seller receives an inquiry with no discernible sender.
    const buyerName = args.buyerName.trim();
    const message = args.message.trim();
    if (buyerName.length < 2 || !message) {
      throw new BadRequestException('Enter your name and a question.');
    }

    const submission = {
      productId: args.productId,
      buyerName,
      buyerPhone,
      message,
    };

    // Already submitted? Return the SAME row rather than creating another.
    //
    // A lost response is indistinguishable from a failed one, so a buyer or a
    // script retrying is expected rather than exceptional. The unique index on
    // idempotencyKey is what enforces this; the lookup only avoids a round
    // trip in the common case.
    const existing = await this.prisma.inquiry.findUnique({
      where: { idempotencyKey: args.idempotencyKey },
    });
    if (existing) return assertSameSubmission(existing, submission);

    // A nonexistent product is rejected BEFORE a transaction is opened.
    //
    // The authoritative read still happens inside the transaction below, and
    // still decides which seller the row is attributed to -- this does not
    // replace it and cannot, because a product can vanish in the gap. What it
    // removes is the cheapest attack's cost: an unauthenticated caller
    // spraying random productIds was paying one SERIALIZABLE transaction per
    // request, and now pays one indexed lookup.
    //
    // It does not bound request workload in general -- an exhausted bucket
    // still costs a transaction and four counts per attempt -- and nothing
    // inside this table's accounting can. That needs a request-level control
    // at the edge; see #152.
    const exists = await this.prisma.product.findUnique({
      where: { id: args.productId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Product ${args.productId} not found`);
    }

    const ipHash = hashIp(args.callerIp);

    try {
      return await this.insertInquiry({
        idempotencyKey: args.idempotencyKey,
        ...submission,
        ipHash,
      });
    } catch (error) {
      // P2002 is the idempotency key colliding: two requests both passed the
      // lookup above before either inserted, and this one lost. The winner's
      // row IS the correct response -- an error here would tell a buyer their
      // inquiry failed when it demonstrably succeeded, and invite the retry
      // idempotency exists to make safe.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.inquiry.findUnique({
          where: { idempotencyKey: args.idempotencyKey },
        });
        // Propagated when the winner cannot be read back: silence there would
        // be a success with nothing behind it.
        //
        // Checked here too: losing the race to a DIFFERENT submission that
        // happened to pick the same key is exactly the collision this
        // rejects, and it is the one path where two callers genuinely raced
        // for one key rather than one caller retrying.
        if (winner) return assertSameSubmission(winner, submission);
      }
      throw error;
    }
  }

  private async insertInquiry(args: {
    idempotencyKey: string;
    productId: string;
    buyerName: string;
    buyerPhone: string;
    message: string;
    ipHash: string | null;
  }): Promise<Prisma.InquiryGetPayload<object>> {
    const { buyerName, buyerPhone, message, ipHash } = args;

    // The limit check and the insert are ONE serializable transaction.
    // Checking and then inserting separately is a time-of-check/time-of-use
    // race: concurrent requests all read a count below the threshold and all
    // proceed, which on an unauthenticated endpoint is the path worth
    // hardening. Serializable makes the database reject the loser rather than
    // trusting application-level ordering.
    return this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          // The idempotency check runs INSIDE each attempt, not only once
          // before the first one.
          //
          // Two identical requests race; one is aborted with P2034 and
          // retried. By then the winner has committed, and its row counts
          // against the very limits this attempt is about to check -- so at a
          // limit boundary the retry was rejected with "Too many inquiries"
          // instead of returning the winner, and the P2002 recovery below
          // never ran because the insert was never reached. Rechecking here
          // also means a duplicate never consumes rate-limit budget, which is
          // correct independently: it is one submission.
          const seen = await tx.inquiry.findUnique({
            where: { idempotencyKey: args.idempotencyKey },
          });
          if (seen) return assertSameSubmission(seen, args);

          // Read INSIDE the transaction, and this snapshot is what the insert
          // uses. Reading it before and reusing that copy would let a product
          // reassigned in the gap have its inquiry attributed to the previous
          // seller.
          const product = await tx.product.findUnique({
            where: { id: args.productId },
            include: { seller: true },
          });
          if (!product) {
            throw new NotFoundException(`Product ${args.productId} not found`);
          }

          // A seller with no number on file is DELIBERATELY not rejected here.
          //
          // Product.hasInquiryContact hides the form so a buyer is never shown
          // one that leads nowhere; it is a UI affordance, not an access
          // control, and this is the deliberate asymmetry rather than a gap in
          // it. A direct caller submitting anyway gets the lead captured for
          // whenever that seller is onboarded -- which is the point: throwing
          // it away would discard a real buyer to enforce a rule with no
          // operational consequence, and in this change nothing is delivered
          // to any seller regardless of what they have on file.

          await this.assertWithinRateLimit(tx, {
            buyerPhone,
            productId: args.productId,
            sellerId: product.sellerId,
            ipHash,
          });

          return tx.inquiry.create({
            data: {
              idempotencyKey: args.idempotencyKey,
              productId: product.id,
              // Denormalized at inquiry time: which seller received this is a
              // historical fact and must not follow a later reassignment.
              sellerId: product.sellerId,
              buyerName,
              buyerPhone,
              message,
              ipHash,
              status: InquiryStatus.PENDING,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  /**
   * Retries a transaction the database aborted for serialization reasons.
   *
   * Serializable isolation does not queue conflicting transactions, it aborts
   * one -- Prisma reports P2034. Without this, two buyers submitting at the
   * same instant meant one received an internal error instead of succeeding
   * or being told about the rate limit. The conflict is the database doing
   * its job; the caller should never see it.
   *
   * Only P2034 is retried. Any other failure -- including the rate-limit
   * rejection and an idempotency collision -- propagates immediately, because
   * retrying a deliberate refusal would turn one rejection into three.
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
   * own they are defeated by rotating numbers. They stay because they give a
   * real buyer sane feedback, not because they stop an attacker.
   *
   * The IP limit adds a dimension the caller does not choose freely -- when
   * one is available at all; see resolveCallerIp and hashIp for why it is
   * frequently null, and why null is skipped rather than shared.
   *
   * The per-seller cap is the one still standing when both of the above are
   * rotated, so it is what actually bounds how much a seller can be made to
   * receive. None of this replaces CAPTCHA or verified numbers; it is defence
   * in depth in front of them.
   *
   * Takes the transaction client so the counts and the insert are one atomic
   * unit.
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
      // Skipped when no trustworthy address resolved: counting every such
      // caller as one bucket would let a single one lock out all the others.
      ipHash
        ? tx.inquiry.count({ where: { ipHash, createdAt: { gte: since } } })
        : Promise.resolve(0),
      tx.inquiry.count({ where: { sellerId, createdAt: { gte: since } } }),
    ]);

    if (forSeller >= INQUIRY_RATE_LIMIT_PER_SELLER) {
      // FIX(#152): this cap is itself a targeted denial of service.
      //
      // It is shared across every buyer of this seller, so reaching it
      // rejects all of them -- and 12 rotating, unverified E.164 numbers at
      // the per-phone ceiling reach it, locking a seller's buyers out for the
      // rest of the rolling hour. Nothing verifies phone ownership, and the
      // per-IP limit is skipped by default, so no other limit here stands in
      // the way.
      //
      // Shipped anyway because the alternative is worse, not because it is
      // fine: with no seller-wide cap an anonymous endpoint writes unbounded
      // rows, and once delivery ships that is unbounded outbound messages to
      // a real person's phone. A time-bounded lockout is the lesser harm.
      //
      // The actual fix is a NON-FORGEABLE control in front of this mutation
      // -- edge rate limiting on the true source address, a Turnstile
      // challenge, or verified phone ownership. #152 has the analysis and the
      // options. Until one lands, this cap is the only thing holding the
      // line, which is exactly why it must not be quietly raised or removed.
      //
      // Deliberately vague to the caller. Naming the seller cap hands an
      // attacker a progress indicator for the one limit they cannot rotate
      // around.
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
