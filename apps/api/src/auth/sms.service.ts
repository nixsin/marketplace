import { Injectable, Logger } from '@nestjs/common';

// TODO(Phase 1): replace with MSG91/Gupshup integration (see TECHNICAL_PLAN.md §5).
// Requires provider account + API key — not available at scaffold time.
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  // Stays async on purpose: the real MSG91/Gupshup call this replaces
  // will be, and every caller already awaits this as if it were.
  // eslint-disable-next-line @typescript-eslint/require-await
  async sendOtp(phone: string, code: string): Promise<void> {
    this.logger.warn(
      `[DEV STUB] Would send OTP ${code} to ${phone} via SMS/WhatsApp provider`,
    );
  }
}
