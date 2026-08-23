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
 * NOTHING IS TRUSTED BY DEFAULT, and in the opted-in mode exactly ONE header
 * is. Every other candidate was tried and each is wrong in its own way:
 *
 *   x-forwarded-for is APPENDED TO by proxies, not overwritten. A client can
 *   send their own chain and the proxy adds to it, so the left-most entry --
 *   nominally "the originating client" -- is attacker-controlled, and
 *   rotating it walks straight past the per-IP limit. Reading it from the
 *   trusted end instead needs a configured trusted-hop count that nothing
 *   here has. It is simply not used.
 *
 *   req.ip inherits that exactly: Express derives it from X-Forwarded-For
 *   whenever app-level `trust proxy` is enabled, a setting invisible here.
 *
 *   socket.remoteAddress is unforgeable but not per-client: Render fronts
 *   every service with a load balancer, so it is the BALANCER, identical for
 *   every buyer. Using it gave everyone one bucket, and once the per-IP limit
 *   was reached it rejected every caller for every seller -- a global outage
 *   of the feature caused by the fix for the forgery problem.
 *
 * cf-connecting-ip is different in the one way that matters: Cloudflare
 * OVERWRITES it rather than appending, so a client-supplied value cannot
 * survive the edge. That holds only if every route to the origin goes through
 * Cloudflare, and this origin also answers directly on its .onrender.com
 * hostname -- which is why it takes an explicit opt-in, and why the opt-in
 * means "the origin now refuses traffic that did not arrive through the
 * proxy", not merely "we are behind a proxy".
 *
 * Without that flag this returns null and the per-IP limit does not run at
 * all. That is the honest answer when no per-client address exists, and the
 * limiter skips a null bucket rather than collapsing every caller into a
 * shared one.
 */
export function resolveCallerIp(
  req?: RequestLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!req) return null;
  if (env[INQUIRY_TRUST_PROXY_HEADERS_ENV] !== 'true') return null;

  const value = req.headers?.['cf-connecting-ip'];
  const raw = Array.isArray(value) ? value[0] : value;
  // A single address, never a chain. cf-connecting-ip carries exactly one;
  // anything with a comma in it did not come from the edge, and splitting it
  // would quietly accept the forgeable shape this function refuses.
  if (!raw || raw.includes(',')) return null;
  return raw.trim() || null;
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
    // Deliberately narrow, and narrower than before: `status` used to be
    // here. It was harmless in the capture change because every row was
    // PENDING, and delivery turned it into a real outcome still handed to an
    // unauthenticated caller -- so anyone could probe whether a given seller
    // is currently reachable, which is more than Product.hasInquiryContact
    // already discloses. The buyer never needed it; part 4 adds `delivered`
    // instead, meaning "the provider accepted it" and nothing more.
    return {
      id: inquiry.id,
      createdAt: inquiry.createdAt,
    };
  }
}
