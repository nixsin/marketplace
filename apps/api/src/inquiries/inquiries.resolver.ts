import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
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
 * cf-connecting-ip FIRST, because the API sits behind Cloudflare and it is
 * the only one of these a client cannot forge -- Cloudflare overwrites it at
 * the edge. x-forwarded-for is client-settable on a direct request, so it is
 * a fallback rather than the primary, and only its first entry is read.
 *
 * Returns null rather than a placeholder when nothing resolves: the limiter
 * skips a null bucket, because collapsing every unresolvable caller into one
 * shared bucket would let a single one of them lock out all the others.
 */
export function resolveCallerIp(req?: RequestLike): string | null {
  if (!req) return null;
  const header = (name: string): string | null => {
    const value = req.headers?.[name];
    const raw = Array.isArray(value) ? value[0] : value;
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
