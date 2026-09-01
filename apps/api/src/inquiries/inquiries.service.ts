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
  INQUIRY_SUMMARY_NAME_MAX_LENGTH,
} from '@medinstru/config';
import { Prisma } from '../../generated/prisma/client';
import { InquiryStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeE164 } from './phone';
import { WhatsappService, truncateByCodePoint } from './whatsapp.service';

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
    // "already used", NOT "already sent". categorizeInquiryError maps
    // "already sent inquiries" to the rate-limit category, and the first
    // wording of this message collided with it -- so a buyer hitting a key
    // conflict was told they had sent too many inquiries recently, which is
    // both wrong and unactionable. The client keys off these strings, so the
    // wording is a wire contract, not prose.
    throw new BadRequestException(
      'This submission id was already used for different details. Reload the page and try again.',
    );
  }
  return existing;
}

/**
 * What insertInquiry hands back: the row AND the product snapshot the
 * transaction actually read.
 *
 * The product travels with the row deliberately. Re-reading it after the
 * transaction to find the seller's number would reintroduce exactly the gap
 * the in-transaction read closes -- a reassignment between the two reads
 * would deliver a buyer's name and phone number to an organisation with
 * nothing to do with the listing.
 */
export type InsertedInquiry =
  /**
   * This call wrote the row, and carries the product snapshot the
   * transaction read. Delivery happens only on this shape.
   */
  | {
      inserted: true;
      inquiry: Prisma.InquiryGetPayload<object>;
      product: {
        id: string;
        name: string;
        sellerId: string;
        seller: { whatsappNumber: string | null };
      };
    }
  /**
   * The idempotency key already existed. NO product, deliberately: the caller
   * must not deliver, so it has no business reading one -- and the type is
   * what enforces that rather than a convention someone can forget.
   */
  | { inserted: false; inquiry: Prisma.InquiryGetPayload<object> };

/**
 * Whether retrying a failed write could plausibly succeed.
 *
 * Fails fast ONLY on errors we know a retry cannot fix. That polarity is
 * deliberate: an unrecognised error is far more likely to be a transient
 * connection problem than a permanent one, the cost of a needless retry is
 * 50ms, and the cost of not retrying a transient failure is a row that lies
 * about what happened.
 *
 * The point of discriminating at all is debuggability. Retrying everything
 * meant a malformed update payload -- a programming error -- burned three
 * attempts, logged three times and was then swallowed, presenting as a
 * database problem. Those surface on the first attempt now.
 */
function isRetryableWriteError(error: unknown): boolean {
  // A VALIDATION error is a programming mistake -- a malformed update payload
  // -- and it is not a PrismaClientKnownRequestError, so the fallthrough below
  // was retrying it three times and then swallowing it. That is precisely the
  // case this function was added to stop, and it was slipping past the check
  // meant to catch it.
  if (error instanceof Prisma.PrismaClientValidationError) return false;
  // An engine panic leaves the client unusable; retrying cannot help.
  if (error instanceof Prisma.PrismaClientRustPanicError) return false;

  // Raw connection failures, initialisation errors and unknown-shape errors
  // land here, and all of them can plausibly succeed on a second attempt.
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return true;

  // P2025 not found, P2002 unique violation, P2003 FK violation and friends
  // are decisions the database has already made; it will make the same one
  // again.
  return new Set([
    'P1001', // cannot reach the database
    'P1002', // database timed out
    'P1008', // operation timed out
    'P1017', // server closed the connection
    'P2024', // timed out fetching a connection from the pool
    'P2034', // write conflict / deadlock
    'P2037', // too many database connections -- transient under load
  ]).has(error.code);
}

/**
 * How many times an outcome write is attempted before giving up.
 *
 * Three, with a short pause between: a failing write here is almost always
 * transient -- a connection recycled, a brief pool exhaustion -- and one
 * attempt turned that into a permanently wrong row.
 */
const OUTCOME_WRITE_ATTEMPTS = 3;
const OUTCOME_WRITE_RETRY_MS = 50;

/** Provider text on a column an operator reads, not an unbounded sink. */
const FAILURE_REASON_MAX_LENGTH = 500;

/**
 * The public site origin, or null when what we have is not one.
 *
 * NEXT_PUBLIC_SITE_URL is easy to miss on the API service because its name
 * says NEXT_PUBLIC. It used to carry a `http://localhost:3000` fallback, so
 * an API without it resolved that in production and every seller received
 * `Link: http://localhost:3000/en/products/...`. A dead link, in the outbound
 * message that is the entire point of this feature.
 *
 * The same misconfiguration already shipped once on the web side, where
 * shared links pointed at localhost. That one could be repaired at runtime by
 * reading window.location.origin; this one cannot, because there is no
 * browser -- which is why the link is OMITTED rather than emitted broken. A
 * seller who gets the buyer's name, number and product still has everything
 * they need to reply; a seller who clicks a localhost link concludes the
 * marketplace is broken.
 */
/**
 * Loopback or the unspecified address, in any spelling.
 *
 * A list of exact strings kept missing spellings of the same thing: `[::1]`
 * because URL.hostname keeps the brackets, then `localhost.` with the root
 * dot, `127.0.0.2` (the whole 127/8 is loopback), and `::ffff:127.0.0.1`,
 * which URL normalises to the hex form `::ffff:7f00:1`. Each was a different
 * way of writing "this machine" that the previous check let through into a
 * seller's message as a link nobody can open.
 *
 * PRIVATE and LINK-LOCAL addresses are deliberately NOT rejected. Loopback
 * means "unconfigured" -- it is the fallback this whole function exists to
 * catch. A 10.x or 192.168.x origin is the opposite: someone typed it, and an
 * internal or staging deployment where that address is exactly right would
 * have its links silently dropped if this refused them.
 */
function isLoopbackHost(hostname: string): boolean {
  // Brackets around an IPv6 literal, and the root dot, are spelling rather
  // than identity.
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

  if (host === 'localhost' || host === '0.0.0.0' || host === '::') return true;
  if (host === '::1') return true;
  // All of 127.0.0.0/8, not just .1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv4-mapped IPv6, in either the dotted or the normalised hex form.
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  // The mapped UNSPECIFIED address too: `::ffff:0.0.0.0` normalises to
  // `::ffff:0:0`, which the 127/8 patterns above do not match, so it slipped
  // through while plain `0.0.0.0` and `::` were rejected. Same class, one
  // spelling further out.
  if (host === '::ffff:0:0' || host === '::ffff:0.0.0.0') return true;

  return false;
}

/**
 * Read straight from the environment, with NO default.
 *
 * NOT `@medinstru/config/web`'s SITE_URL, even though that is the same
 * variable: that export THROWS on a deployment when unset, which is right for
 * apps/web (a localhost canonical URL reaches crawlers) and wrong here. This
 * service already handles absence better than a throw would -- it omits the
 * link, logs `[NOT CONFIGURED]` naming the variable, and still delivers the
 * buyer's name, number and Ref, so the inquiry stays actionable. Refusing to
 * boot the whole API would trade a degraded message for no message.
 *
 * That is degradation, not a silent fallback: the old
 * `SITE_URL = ... ?? "http://localhost:3000"` meant production resolved a
 * localhost link and SENT it. The contract marks NEXT_PUBLIC_SITE_URL
 * required on render, so a real deploy still refuses to start without it --
 * the hard failure lives at boot, where it can be acted on.
 */
function configuredSiteUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SITE_URL;
}

export function publicSiteUrl(
  siteUrl: string | undefined = configuredSiteUrl(),
): string | null {
  if (!siteUrl) return null;

  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return null;
  }

  // Scheme checked, because a link is built by concatenation and anything
  // else produces something that is not a web address at all. `javascript:`
  // parses happily and yielded `javascript:alert(1)/en/products/<id>` in an
  // outbound message.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  if (isLoopbackHost(url.hostname)) return null;

  // ORIGIN, not the string as given. The previous version returned the input
  // with a trailing slash trimmed, so a query, a path or embedded credentials
  // survived into a link built by concatenation:
  //   https://example.com?x=1     -> https://example.com?x=1/en/products/<id>
  //   https://user:pass@example.com -> credentials in a message to a seller
  // url.origin drops all three, which is the only part of a configured site
  // URL a product link should be built from.
  return url.origin;
}

/**
 * The metadata half of the outbound message.
 *
 * CONTACT FIRST, and the product name bounded. The From line used to come
 * last, and template parameters truncate from the end -- product names are
 * unbounded `String` in the schema and the seeded catalogue already has a
 * deliberately absurd one, so a long enough name pushed the buyer's name and
 * phone number off the end entirely. The seller then received an inquiry with
 * no way to reply to it, which is worse than receiving nothing: it looks
 * answerable and is not.
 *
 * Ordering alone would protect the contact line; bounding the name as well
 * keeps the whole summary comfortably inside the parameter budget. NOT a
 * guarantee, and the earlier wording claiming one was wrong: productId is
 * interpolated twice and the configured origin is unbounded, so nothing here
 * proves a ceiling. What holds is measured rather than asserted -- the worst
 * realistic summary is 443 of 1024 characters, and a test pins that -- and
 * the ordering is what makes the remaining risk survivable, since truncation
 * eats the link before it reaches the contact line.
 *
 * Buyer-supplied values are labelled and NOT escaped: WhatsApp text bodies are
 * not markup, so escaping would corrupt legitimate content. The protection
 * that matters is the length cap at the DTO boundary.
 */
export function buildInquirySummary(input: {
  productName: string;
  productId: string;
  buyerName: string;
  buyerPhone: string;
  siteUrl?: string;
}): string {
  const base = publicSiteUrl(input.siteUrl ?? configuredSiteUrl());
  // Truncated by CODE POINT. .slice() counts UTF-16 code units, so a product
  // name with a non-BMP character straddling the boundary left an unpaired
  // surrogate in the outbound summary. Readily reachable -- unlike the
  // template-parameter cap this was parked alongside, a 200-character name is
  // ordinary, and medical device names carry CJK and symbols routinely.
  const name =
    [...input.productName].length > INQUIRY_SUMMARY_NAME_MAX_LENGTH
      ? `${truncateByCodePoint(input.productName, INQUIRY_SUMMARY_NAME_MAX_LENGTH - 1)}\u2026`
      : input.productName;

  return [
    `New inquiry via the marketplace`,
    ``,
    `From: ${input.buyerName} (${input.buyerPhone})`,
    ``,
    `Product: ${name}`,
    `Ref: ${input.productId}`,
    // Omitted rather than emitted broken when no public origin is configured.
    // The Ref line is what keeps the inquiry traceable without it.
    ...(base ? [`Link: ${base}/en/products/${input.productId}`] : []),
  ].join('\n');
}

/**
 * The whole message as one string, for the non-template text path.
 *
 * The two halves stay SEPARATE for the template path, where each is its own
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
 * volume. The 500-character truncation on the database column happens AFTER
 * the log call, so it protects the wrong thing.
 */
export function sanitizeForLog(value: string, max = 200): string {
  // \p{Cf} as well as \p{Cc}. Stripping only control characters left FORMAT
  // characters through -- U+202E RIGHT-TO-LEFT OVERRIDE among them, which
  // visually reverses the rest of a line. This function exists precisely to
  // stop provider text forging log entries, and a reordered line forges one
  // just as effectively as an injected newline.
  // Three classes, because each was missed in turn.
  //
  // \r \n \t are the obvious ones, and \p{Cc} covers the remaining C0/C1
  // controls. \p{Cf} covers FORMAT characters -- U+202E RIGHT-TO-LEFT
  // OVERRIDE among them, which visually reverses the rest of a line.
  //
  // U+2028 and U+2029 belong to NEITHER category: they are Zl and Zp, line
  // and paragraph separators. JavaScript treats them as real line
  // terminators, so provider text carrying one splits a log line exactly as
  // \n does -- the whole thing this function exists to prevent. Matched
  // explicitly, since no character class groups them with the controls.
  // Whitespace collapsed with the SAME rule its sibling in whatsapp.service
  // uses, so the two cannot disagree about what counts. `\s` covers vertical
  // whitespace, U+00A0 and U+FEFF; U+0085 NEXT LINE is added explicitly
  // because JS `\s` does not match it.
  //
  // Then \p{Cc} for the remaining C0/C1 controls and \p{Cf} for FORMAT
  // characters -- U+202E RIGHT-TO-LEFT OVERRIDE among them, which visually
  // reverses the rest of a line and forges an entry as effectively as an
  // injected newline. U+2028/U+2029 are Zl/Zp and belong to neither category,
  // which is why the whitespace rule has to run first.
  const flat = value
    .replace(/[\s\u0085]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '');
  // Truncated by CODE POINT, like the other two truncations in this feature.
  // This one was missed when they were fixed -- the class was "cuts that
  // split a surrogate pair", and fixing the two cited instances left the
  // third. Provider error text is the most likely of the three to carry a
  // non-BMP character, since it can echo arbitrary input back.
  return [...flat].length > max
    ? `${truncateByCodePoint(flat, max - 1)}\u2026`
    : flat;
}

@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Records the inquiry, THEN attempts delivery.
   *
   * That order is the whole design, and it is why the capture change shipped
   * first. A send that fails -- bad credentials, a Meta outage, a seller
   * number Meta rejects -- must still leave a lead the marketplace can see
   * and retry (#91 story 9). Sending first and persisting after loses the
   * lead precisely when something is already wrong.
   *
   * Delivery can never fail the mutation. Every path below either updates the
   * row or logs and returns what it knows, because by the time any of it runs
   * the buyer's inquiry is already saved, and telling them otherwise invites
   * a resubmission of something that was recorded.
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

    let created: InsertedInquiry;
    try {
      created = await this.insertInquiry({
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
        //
        // NOT delivered again. The winner's own request is what sends; this
        // one lost the race and is a duplicate of it, so sending here would
        // put the same inquiry on the seller's phone twice.
        if (winner) return assertSameSubmission(winner, submission);
      }
      throw error;
    }

    // Delivered ONLY when this call actually wrote the row. A retry that
    // matched the idempotency key returns the stored row untouched -- the
    // request that created it is what sends, and sending again would put the
    // same inquiry on the seller's phone twice.
    //
    // FIX(#151): a crash in the gap between that commit and this send strands
    // the row forever. The transaction has committed by the time we get here,
    // so a process restart, a deploy, or a cancelled request leaves a PENDING
    // row that no later retry will deliver -- every retry matches the
    // idempotency key and returns without sending, which is correct for a
    // duplicate and wrong for one that was never attempted.
    //
    // FREQUENCY: a window of milliseconds, and only while the provider is
    // configured at all -- unconfigured, delivery resolves synchronously to
    // FAILED before anything can interrupt it. Zero occurrences are possible
    // today.
    //
    // FIX WHEN TOUCHED: the same recovery mechanism the ambiguous-outcome
    // case needs -- a sweep of PENDING rows -- distinguishing
    // never-attempted from attempted-ambiguous, which providerMessageId
    // already does. An outbox written in the same transaction is the fuller
    // answer.
    //
    // Related, same issue: a row that reached FAILED is likewise never
    // delivered by any later request, even once the cause is repaired --
    // credentials set, a seller number added, a 429 window passed. Those are
    // DEFINITE non-deliveries and safe to re-send by construction, but doing
    // it here would hand an attacker an amplifier: a duplicate deliberately
    // consumes no rate-limit budget, so a known key could drive unlimited
    // outbound requests. It belongs to the sweeper, which we trigger and
    // pace.
    // The union makes this a type-level guarantee: `created.product` does not
    // exist on the not-inserted branch, so delivering a duplicate is a
    // compile error rather than a convention to remember.
    if (!created.inserted) return created.inquiry;

    // Wrapped, so NOTHING in delivery can fail the mutation.
    //
    // Every branch inside deliver() already handles its own errors, and
    // sendInquiry returns a result rather than throwing -- but "does not
    // throw" is a property of that code today, not a guarantee this one can
    // rest on. sendInquiry builds its request payload BEFORE its own try, and
    // the whole design of this method is that the lead is saved before any of
    // it runs. An escape here tells the buyer their inquiry failed when it is
    // sitting in the table, and invites them to submit it again.
    try {
      return await this.deliver(created, submission);
    } catch (error) {
      this.logger.error(
        `Inquiry ${created.inquiry.id} was recorded but delivery threw ` +
          `unexpectedly; the lead is safe and the row is left as written: ` +
          `${sanitizeForLog(error instanceof Error ? error.message : 'unknown error')}`,
      );
      return created.inquiry;
    }
  }

  /**
   * Hands a recorded inquiry to the provider and records what came back.
   *
   * Separate from create() because every branch here is about an outcome that
   * has already been persisted. Nothing in it may throw: see markFailed.
   */
  private async deliver(
    // The INSERTED branch only. Taking the union here would let a caller pass
    // a duplicate and have it delivered; taking the narrowed type makes that
    // impossible to write.
    created: Extract<InsertedInquiry, { inserted: true }>,
    submission: SubmissionIdentity,
  ): Promise<Prisma.InquiryGetPayload<object>> {
    const { inquiry, product } = created;

    const sellerNumber = product.seller.whatsappNumber;
    if (!sellerNumber) {
      // A seller with no number is a CONFIGURATION state, not a buyer error.
      // The lead is captured and deliverable once that seller is onboarded,
      // so it must not surface as a failed request -- and the form is hidden
      // for such sellers anyway (Product.hasInquiryContact), so reaching this
      // means a direct caller, or a number removed after the page loaded.
      return this.markFailed(inquiry, 'seller has no WhatsApp number');
    }

    if (!publicSiteUrl()) {
      // Loud, and naming the variable. The send still goes -- the buyer's
      // number is what makes an inquiry actionable -- but the seller gets no
      // link, and an operator should know why rather than discovering it from
      // a seller asking.
      this.logger.warn(
        `[NOT CONFIGURED] NEXT_PUBLIC_SITE_URL is unset or points at ` +
          `localhost on this service, so outbound inquiries carry no product ` +
          `link. render.yaml declares it for the web service only.`,
      );
    }

    const result = await this.whatsapp.sendInquiry(sellerNumber, {
      summary: buildInquirySummary({
        productName: product.name,
        productId: product.id,
        buyerName: submission.buyerName,
        buyerPhone: submission.buyerPhone,
      }),
      // The buyer's own words, kept as their own template parameter so they
      // are never truncated by metadata sitting in front of them.
      buyerMessage: submission.message,
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
        // FREQUENCY: requires a provider timeout or a dropped connection,
        // which cannot occur at all until Meta credentials exist.
        //
        // FIX WHEN TOUCHED: a delivery webhook keyed on providerMessageId,
        // which is already stored for exactly this purpose.
        this.logger.warn(
          `Inquiry ${inquiry.id} has an AMBIGUOUS provider outcome, left ` +
            `PENDING rather than FAILED: ${reason}`,
        );

        // The ATTEMPT is recorded, even though the status is not changed.
        //
        // Without this the branch wrote nothing at all, so a row left PENDING
        // by an ambiguous send was byte-identical to one left PENDING by a
        // crash before the send -- and the recovery sweep those cases are
        // parked for could not tell them apart. It cannot use
        // providerMessageId to distinguish them either, because an ambiguous
        // send never returns one; that was an error in this feature's own
        // notes, corrected here and in #151.
        //
        // failureReason on a PENDING row reads oddly, but the alternative is
        // a column that exists only to say "definitely failed" and a sweeper
        // that cannot function. Status stays PENDING because that is what is
        // true: we do not know.
        return this.recordAttempt(inquiry, result.reason);
      }

      this.logger.warn(
        `Inquiry ${inquiry.id} recorded but not delivered: ${reason}`,
      );
      return this.markFailed(inquiry, result.reason);
    }

    // The provider has ALREADY accepted the message at this point. If
    // recording that fact fails, the send still happened -- so surfacing the
    // write error would tell the buyer their inquiry did not go through and
    // invite a retry that sends the seller a duplicate.
    //
    // TODO(#151): sweep rows stuck PENDING after an accepted send.
    // Reconciliation is manual today; nothing sweeps them.
    //
    // FREQUENCY: requires a database failure inside the window between an
    // accepted send and its status write -- milliseconds, and only while the
    // provider is configured at all.
    const written = await this.writeOutcome(
      inquiry,
      {
        status: InquiryStatus.SENT,
        providerMessageId: result.providerMessageId,
      },
      'an accepted send',
    );
    if (written) return written;

    // The write ultimately failed, and the provider has ALREADY accepted the
    // message. Returned as SENT even though the row is not: reporting
    // otherwise would tell the buyer we could not reach the seller for a
    // message that had in fact arrived, and invite a retry that duplicates.
    //
    // The row now says PENDING with nothing else set, which the #151 sweeper
    // reads as "never attempted" -- so it would re-send this. The log line
    // above carries the provider message id precisely so a human can tell
    // these apart until that sweeper knows how to.
    this.logger.error(
      `Inquiry ${inquiry.id} was DELIVERED (provider id ` +
        `${sanitizeForLog(result.providerMessageId ?? 'unknown', 64)}) but ` +
        `remains PENDING; do NOT re-send it.`,
    );
    return {
      ...inquiry,
      status: InquiryStatus.SENT,
      providerMessageId: result.providerMessageId,
    };
  }

  /**
   * Writes a delivery outcome onto the row, retrying a transient failure.
   *
   * WHY RETRY AT ALL, when the caller already degrades gracefully: because
   * the fallback leaves the row LYING about what happened, and the lie is the
   * dangerous kind. A send Meta accepted whose status write failed leaves
   * `status: PENDING`, `providerMessageId: null`, `failureReason: null` --
   * which is byte-identical to a row that was never attempted. The recovery
   * sweep in #151 reads exactly those columns, so it would classify an
   * already-delivered inquiry as safe to send and put it on the seller's
   * phone a second time. That is the one outcome this whole feature is built
   * to avoid.
   *
   * A failing write here is almost always transient -- a recycled connection,
   * a moment of pool exhaustion -- so retrying converts most of these into
   * rows that tell the truth. It cannot close the window entirely: if the
   * database is genuinely gone, nothing can be written, and the log line is
   * the only record. That residual is recorded in #151 as something the
   * sweeper must handle, not something a retry makes go away.
   */
  private async writeOutcome(
    inquiry: Prisma.InquiryGetPayload<object>,
    data: Prisma.InquiryUpdateInput,
    what: string,
  ): Promise<Prisma.InquiryGetPayload<object> | null> {
    for (let attempt = 1; attempt <= OUTCOME_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.inquiry.update({
          where: { id: inquiry.id },
          data,
        });
      } catch (error) {
        // Stop early on an error a retry cannot fix, so a programming mistake
        // surfaces on the first attempt rather than looking like a flaky
        // database three log lines later.
        const done =
          attempt === OUTCOME_WRITE_ATTEMPTS || !isRetryableWriteError(error);
        const detail = sanitizeForLog(
          error instanceof Error ? error.message : 'unknown error',
        );

        if (done) {
          this.logger.error(
            `Inquiry ${inquiry.id}: ${what} could not be recorded after ` +
              `${attempt} attempt(s); the row does not reflect what happened ` +
              `and needs reconciling: ${detail}`,
          );
          return null;
        }

        this.logger.warn(
          `Inquiry ${inquiry.id}: ${what} write failed, retrying ` +
            `(${attempt}/${OUTCOME_WRITE_ATTEMPTS - 1}): ${detail}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, OUTCOME_WRITE_RETRY_MS),
        );
      }
    }
    // Unreachable: the loop either returns a row or returns null on its last
    // attempt. Present because TypeScript cannot see that.
    return null;
  }

  /**
   * Notes an ambiguous attempt without claiming an outcome.
   *
   * Status deliberately untouched: PENDING is what is true. Only the reason
   * is stored, so a later sweep can tell an attempted-but-unknown row from
   * one that was never attempted at all.
   */
  private async recordAttempt(
    inquiry: Prisma.InquiryGetPayload<object>,
    reason: string,
  ): Promise<Prisma.InquiryGetPayload<object>> {
    const failureReason = sanitizeForLog(reason, FAILURE_REASON_MAX_LENGTH);

    // Status deliberately untouched: PENDING is what is true. Only the reason
    // is stored, so a later sweep can tell an attempted-but-unknown row from
    // one that was never attempted at all.
    const written = await this.writeOutcome(
      inquiry,
      { failureReason },
      'an ambiguous outcome',
    );
    if (written) return written;

    return { ...inquiry, failureReason };
  }

  /**
   * Records a delivery failure, and cannot itself fail the mutation.
   *
   * The inquiry is ALREADY persisted by the time this runs, so letting a
   * transient database error escape would tell the buyer their submission
   * failed and invite them to resubmit something already recorded.
   */
  private async markFailed(
    inquiry: Prisma.InquiryGetPayload<object>,
    reason: string,
  ): Promise<Prisma.InquiryGetPayload<object>> {
    // Flattened before STORAGE, not only before logging: this is
    // provider-supplied text on a column an operator reads and may paste
    // elsewhere.
    const failureReason = sanitizeForLog(reason, FAILURE_REASON_MAX_LENGTH);

    const written = await this.writeOutcome(
      inquiry,
      { status: InquiryStatus.FAILED, failureReason },
      'a delivery failure',
    );
    if (written) return written;

    // The row that WAS persisted, with what we know applied in memory.
    // Re-reading from the database that just failed is no more likely to
    // work, and pushing the error to the caller is the very thing this exists
    // to prevent -- the inquiry is already saved, so telling the buyer it
    // failed would invite them to resubmit something recorded.
    return { ...inquiry, status: InquiryStatus.FAILED, failureReason };
  }

  private async insertInquiry(args: {
    idempotencyKey: string;
    productId: string;
    buyerName: string;
    buyerPhone: string;
    message: string;
    ipHash: string | null;
  }): Promise<InsertedInquiry> {
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
          // The idempotency check runs FIRST, and inside each attempt.
          //
          // First, because a recorded submission is answerable without a
          // product: it is not being delivered, so no snapshot is needed. The
          // previous order read the product before this check, which made a
          // retry throw NotFound if the product had since been removed --
          // breaking the idempotency contract for a row that plainly exists.
          // Unreachable while Inquiry.productId is ON DELETE RESTRICT, since
          // a product with inquiries cannot be deleted at all, but resting
          // correctness on a constraint elsewhere is not a reason to keep the
          // weaker order.
          //
          // Inside each attempt, because two identical requests race and one
          // is aborted with P2034 and retried. By then the winner has
          // committed, and its row counts against the very limits this
          // attempt is about to check -- so at a limit boundary the retry was
          // rejected with "Too many inquiries" instead of returning the
          // winner, and the P2002 recovery below never ran because the insert
          // was never reached. Rechecking here also means a duplicate never
          // consumes rate-limit budget, which is correct independently: it is
          // one submission.
          const seen = await tx.inquiry.findUnique({
            where: { idempotencyKey: args.idempotencyKey },
          });
          if (seen) {
            // NOT delivered: this row already exists, so the request that
            // wrote it is what sends. No product is returned, so nothing
            // downstream can accidentally deliver off this branch.
            return {
              inserted: false,
              inquiry: assertSameSubmission(seen, args),
            };
          }

          // Read INSIDE the transaction, and this snapshot is what the insert
          // AND the send use. Reading it outside and reusing that copy would
          // let a product reassigned in the gap have its inquiry attributed
          // to the previous seller -- which once delivery exists means the
          // buyer's name, phone and question handed to an organisation with
          // nothing to do with the listing. Nothing reassigns products today,
          // which is exactly why it would have gone unnoticed.
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

          const inquiry = await tx.inquiry.create({
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

          // The product snapshot travels WITH the row. Looking the seller's
          // number up again after the transaction closed would reopen the
          // reassignment gap this read exists to close.
          return { inserted: true, inquiry, product };
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
