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

  // socket.remoteAddress, NOT req.ip, when the flag is off.
  //
  // Express derives req.ip from X-Forwarded-For whenever app-level `trust
  // proxy` is enabled -- which is a setting elsewhere in the app, invisible
  // from here. Preferring req.ip therefore let a spoofable value back in
  // through the side door and silently undid this function's whole point.
  // The socket address is the peer we are actually speaking to.
  const socketAddress = req.socket?.remoteAddress ?? null;
  if (env[INQUIRY_TRUST_PROXY_HEADERS_ENV] !== 'true') return socketAddress;

  const header = (name: string): string | null => {
    const value = req.headers?.[name];
    const raw = Array.isArray(value) ? value[0] : value;
    // Only the first entry of x-forwarded-for: the rest are appended by
    // intermediaries and the left-most is the originating client.
    return raw ? raw.split(',')[0].trim() || null : null;
  };

  return (
    header('cf-connecting-ip') ?? header('x-forwarded-for') ?? socketAddress
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
