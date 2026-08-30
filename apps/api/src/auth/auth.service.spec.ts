// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { OtpStoreService } from './otp-store.service';
import { SmsService } from './sms.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let otpStore: { set: jest.Mock; verify: jest.Mock };
  let sms: { sendOtp: jest.Mock };
  let jwt: { sign: jest.Mock; verify: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    otpStore = { set: jest.fn(), verify: jest.fn() };
    sms = { sendOtp: jest.fn().mockResolvedValue(undefined) };
    jwt = { sign: jest.fn(), verify: jest.fn() };

    service = new AuthService(
      prisma as unknown as PrismaService,
      otpStore as unknown as OtpStoreService,
      sms as unknown as SmsService,
      jwt as unknown as JwtService,
    );
  });

  describe('requestOtp', () => {
    it('generates a 6-digit code, stores it, and sends it via SMS', async () => {
      const result = await service.requestOtp('+919876543210');

      expect(result).toEqual({ sent: true });
      expect(otpStore.set).toHaveBeenCalledWith(
        '+919876543210',
        expect.stringMatching(/^\d{6}$/),
      );
      expect(sms.sendOtp).toHaveBeenCalledWith(
        '+919876543210',
        otpStore.set.mock.calls[0][1],
      );
    });
  });

  describe('verifyOtp', () => {
    it('throws UnauthorizedException for an invalid/expired code', async () => {
      otpStore.verify.mockReturnValue(false);

      await expect(
        service.verifyOtp('+919876543210', '000000'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('returns a full access token for an existing user', async () => {
      otpStore.verify.mockReturnValue(true);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user_1',
        organizationId: 'org_1',
        role: 'ADMIN',
      });
      jwt.sign.mockReturnValue('signed.jwt.token');

      const result = await service.verifyOtp('+919876543210', '123456');

      expect(jwt.sign).toHaveBeenCalledWith({
        sub: 'user_1',
        orgId: 'org_1',
        role: 'ADMIN',
      });
      expect(result).toEqual({
        accessToken: 'signed.jwt.token',
        isNewUser: false,
      });
    });

    it('returns a scoped onboarding token when no account exists yet', async () => {
      otpStore.verify.mockReturnValue(true);
      prisma.user.findUnique.mockResolvedValue(null);
      jwt.sign.mockReturnValue('onboarding.jwt.token');

      const result = await service.verifyOtp('+919876543210', '123456');

      expect(jwt.sign).toHaveBeenCalledWith(
        { phone: '+919876543210', scope: 'onboarding' },
        { expiresIn: '15m' },
      );
      expect(result).toEqual({
        accessToken: 'onboarding.jwt.token',
        isNewUser: true,
      });
    });
  });

  describe('completeOnboarding', () => {
    const validInput = {
      onboardingToken: 'valid.token',
      userName: 'Test Buyer',
      organization: { name: 'Apollo Diagnostics', type: 'BUYER' as const },
    };

    it('creates an organization + user and returns a full access token', async () => {
      jwt.verify.mockReturnValue({
        phone: '+919876543210',
        scope: 'onboarding',
      });
      const createdOrg = { id: 'org_1', name: 'Apollo Diagnostics' };
      const createdUser = {
        id: 'user_1',
        organizationId: 'org_1',
        role: 'ADMIN',
      };
      prisma.$transaction.mockImplementation((cb) =>
        cb({
          organization: { create: jest.fn().mockResolvedValue(createdOrg) },
          user: { create: jest.fn().mockResolvedValue(createdUser) },
        }),
      );
      jwt.sign.mockReturnValue('final.jwt.token');

      const result = await service.completeOnboarding(validInput);

      expect(jwt.sign).toHaveBeenCalledWith({
        sub: 'user_1',
        orgId: 'org_1',
        role: 'ADMIN',
      });
      expect(result).toEqual({
        accessToken: 'final.jwt.token',
        isNewUser: false,
      });
    });

    it('rejects a token whose scope is not "onboarding"', async () => {
      jwt.verify.mockReturnValue({
        phone: '+919876543210',
        scope: 'session', // e.g. a real login token, not an onboarding one
      });

      await expect(
        service.completeOnboarding(validInput),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an invalid/expired onboarding token', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(
        service.completeOnboarding(validInput),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
