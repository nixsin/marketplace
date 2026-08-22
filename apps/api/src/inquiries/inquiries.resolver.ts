import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { INQUIRY_TRUST_PROXY_HEADERS_ENV } from '@medinstru/config';
import { InquiryStatus } from '../../generated/prisma/enums';
import { CreateInquiryInput } from './dto/create-inquiry.input';
import { InquiriesService } from './inquiries.service';
import { Inquiry } from './models/inquiry.model';

interface RequestLike {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * The caller's address, for the one rate-limit dimension they cannot type.
 *
 * PROXY HEADERS ARE NOT TRUSTED BY DEFAULT, and that is the whole point of
 * this function. An earlier version read cf-connecting-ip unconditionally,
 * with a comment claiming a client could not forge it because Cloudflare
 * overwrites it at the edge. That is only true when every route to the origin
 * goes through Cloudflare -- and this origin answers directly on its
 * .onrender.com hostname, confirmed by curl. A caller who skips the edge could
 * set a fresh cf-connecting-ip on every request, making the per-IP limit
 * forgeable in precisely the way the phone limit already was.
 *
 * So the socket address is used unless INQUIRY_TRUST_PROXY_HEADERS is
 * explicitly enabled, which an operator should do only once the origin
 * refuses traffic that did not arrive through the proxy.
 *
 * Returns null rather than a placeholder when nothing resolves: the limiter
 * skips a null bucket, because collapsing every unresolvable caller into one
 * shared bucket would let a single one of them lock out all the others.
 */
export function resolveCallerIp(
  req?: RequestLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!req) return null;

  // NULL when proxy headers are not trusted, and that is deliberate.
  //
  // The previous version returned socket.remoteAddress here. Behind Render's
  // load balancer -- which fronts every service -- that address is the
  // BALANCER, identical for every buyer. Every caller therefore shared one
  // ipHash, so after INQUIRY_RATE_LIMIT_PER_IP inquiries the limit rejected
  // everyone, for every seller, for the rest of the window. A global outage
  // of the feature, caused by the fix for the spoofing problem.
  //
  // Without trusted proxy headers there is simply no per-client address
  // available, so the honest answer is none. The limiter skips a null bucket
  // rather than collapsing everyone into a shared one, and the per-seller cap
  // remains what actually bounds a seller's exposure.
  if (env[INQUIRY_TRUST_PROXY_HEADERS_ENV] !== 'true') return null;

  const header = (name: string): string | null => {
    const value = req.headers?.[name];
    const raw = Array.isArray(value) ? value[0] : value;
    // Only the first entry of x-forwarded-for: the rest are appended by
    // intermediaries and the left-most is the originating client.
    return raw ? raw.split(',')[0].trim() || null : null;
  };

  // req.ip and the socket are acceptable here only because trusting proxy
  // headers is the explicit, opted-in mode.
  return (
    header('cf-connecting-ip') ??
    header('x-forwarded-for') ??
    req.ip ??
    req.socket?.remoteAddress ??
    null
  );
}

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
    @Context() context: { req?: RequestLike },
  ): Promise<Inquiry> {
    const inquiry = await this.inquiries.create({
      ...input,
      callerIp: resolveCallerIp(context.req),
    });
    return {
      id: inquiry.id,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
      delivered: inquiry.status === InquiryStatus.SENT,
    };
  }
}
