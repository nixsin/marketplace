import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { OtpStoreService } from './otp-store.service';
import { SmsService } from './sms.service';
import { CompleteOnboardingInput } from './dto/complete-onboarding.input';

function randomOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpStore: OtpStoreService,
    private readonly sms: SmsService,
    private readonly jwt: JwtService,
  ) {}

  getUserById(id: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id },
      include: { organization: true },
    });
  }

  async requestOtp(phone: string): Promise<{ sent: boolean }> {
    const code = randomOtp();
    this.otpStore.set(phone, code);
    await this.sms.sendOtp(phone, code);
    return { sent: true };
  }

  async verifyOtp(phone: string, code: string) {
    const valid = this.otpStore.verify(phone, code);
    if (!valid) throw new UnauthorizedException('Invalid or expired code');

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { organization: true },
    });

    if (user) {
      return {
        accessToken: this.jwt.sign({
          sub: user.id,
          orgId: user.organizationId,
          role: user.role,
        }),
        isNewUser: false,
      };
    }

    // No account yet — issue a short-lived, narrowly-scoped token that only
    // proves "this phone completed OTP verification", for completeOnboarding.
    return {
      accessToken: this.jwt.sign(
        { phone, scope: 'onboarding' },
        { expiresIn: '15m' },
      ),
      isNewUser: true,
    };
  }

  async completeOnboarding(input: CompleteOnboardingInput) {
    const payload = this.decodeOnboardingToken(input.onboardingToken);

    const result = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: input.organization,
      });
      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          phone: payload.phone,
          name: input.userName,
          role: 'ADMIN',
        },
      });
      return { organization, user };
    });

    return {
      accessToken: this.jwt.sign({
        sub: result.user.id,
        orgId: result.organization.id,
        role: result.user.role,
      }),
      isNewUser: false,
    };
  }

  private decodeOnboardingToken(token: string): { phone: string } {
    try {
      const payload = this.jwt.verify<{ phone: string; scope: string }>(token);
      if (payload.scope !== 'onboarding') {
        throw new Error('wrong token scope');
      }
      return { phone: payload.phone };
    } catch {
      throw new UnauthorizedException('Invalid or expired onboarding token');
    }
  }
}
