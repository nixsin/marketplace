import { Injectable } from '@nestjs/common';
import { OTP_TTL_MS } from '@medinstru/config';

interface OtpEntry {
  code: string;
  expiresAt: number;
}

// TODO(Phase 1): back this with Redis (see TECHNICAL_PLAN.md §5) so it survives
// restarts and works across multiple API instances. In-memory only holds for
// this scaffold / single-process local dev.
@Injectable()
export class OtpStoreService {
  private readonly store = new Map<string, OtpEntry>();

  set(phone: string, code: string) {
    this.store.set(phone, { code, expiresAt: Date.now() + OTP_TTL_MS });
  }

  verify(phone: string, code: string): boolean {
    const entry = this.store.get(phone);
    if (!entry) return false;
    this.store.delete(phone);
    if (entry.expiresAt < Date.now()) return false;
    return entry.code === code;
  }
}
