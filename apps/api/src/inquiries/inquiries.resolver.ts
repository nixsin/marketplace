import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { INQUIRY_TRUST_PROXY_HEADERS_ENV } from '@medinstru/config';
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
 * PROXY HEADERS ARE NOT TRUSTED BY DEFAULT, and neither is the socket. Both
 * defaults were arrived at by getting them wrong:
 *
 *   cf-connecting-ip is only unforgeable when EVERY route to the origin goes
 *   through Cloudflare, and this origin answers directly on its .onrender.com
 *   hostname -- so a caller who skips the edge can set a fresh value per
 *   request.
 *
 *   socket.remoteAddress is unforgeable but not per-client: Render fronts
 *   every service with a load balancer, so it is the BALANCER, identical for
 *   every buyer. Using it gave everyone one bucket, and after the per-IP limit
 *   was reached it rejected every caller for every seller.
 *
 *   req.ip is worse than either: Express derives it from X-Forwarded-For
 *   whenever app-level `trust proxy` is enabled, a setting invisible from
 *   here.
 *
 * So without INQUIRY_TRUST_PROXY_HEADERS this returns null and the per-IP
 * limit does not run at all. That is the honest answer when no per-client
 * address exists, and the limiter skips a null bucket rather than collapsing
 * every caller into a shared one. Enable it only once the origin refuses
 * traffic that did not arrive through the proxy.
 */
export function resolveCallerIp(
  req?: RequestLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!req) return null;
  if (env[INQUIRY_TRUST_PROXY_HEADERS_ENV] !== 'true') return null;

  const header = (name: string): string | null => {
    const value = req.headers?.[name];
    const raw = Array.isArray(value) ? value[0] : value;
    // Only the first entry of x-forwarded-for: the rest are appended by
    // intermediaries and the left-most is the originating client.
    return raw ? raw.split(',')[0].trim() || null : null;
  };

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
   * Unauthenticated on purpose: #91 story 3 wants a shared product link to
   * work on a cold visit, and requiring an account before a buyer can ask a
   * question is exactly the friction that sends them to a competitor's phone
   * number.
   *
   * The cost of that choice is abuse surface, handled in the service with
   * limits counted from the database rather than an in-process counter.
   *
   * NOTE for when login ships: this must NOT quietly become authenticated. If
   * a session exists, record it alongside the inquiry, but anonymous
   * submission has to keep working.
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
    };
  }
}
