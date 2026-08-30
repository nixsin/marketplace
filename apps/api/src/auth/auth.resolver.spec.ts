// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import type { AuthTokenPayload } from './types/auth-token-payload';
import type { RequestOtpInput } from './dto/request-otp.input';
import type { VerifyOtpInput } from './dto/verify-otp.input';
import type { CompleteOnboardingInput } from './dto/complete-onboarding.input';

describe('AuthResolver', () => {
  let resolver: AuthResolver;
  let mockAuthService: {
    getUserById: jest.Mock;
    requestOtp: jest.Mock;
    verifyOtp: jest.Mock;
    completeOnboarding: jest.Mock;
  };

  beforeEach(() => {
    mockAuthService = {
      getUserById: jest.fn(),
      requestOtp: jest.fn(),
      verifyOtp: jest.fn(),
      completeOnboarding: jest.fn(),
    };
    resolver = new AuthResolver(mockAuthService as unknown as AuthService);
  });

  it("me() looks up the caller's own user by their JWT sub, and returns it unchanged", () => {
    const expectedUser = { id: 'user-1', name: 'Test User' };
    mockAuthService.getUserById.mockReturnValue(expectedUser);
    const user: AuthTokenPayload = {
      sub: 'user-1',
      orgId: 'org-1',
      role: 'ADMIN',
    };

    const result = resolver.me(user);

    expect(mockAuthService.getUserById).toHaveBeenCalledWith('user-1');
    expect(result).toBe(expectedUser);
  });

  it('requestOtp() delegates to the service and returns just the sent flag', async () => {
    mockAuthService.requestOtp.mockResolvedValue({ sent: true });
    const input: RequestOtpInput = { phone: '+919812300000' };

    const result = await resolver.requestOtp(input);

    expect(mockAuthService.requestOtp).toHaveBeenCalledWith('+919812300000');
    expect(result).toBe(true);
  });

  it('verifyOtp() delegates phone + code through unchanged', () => {
    const expectedPayload = { accessToken: 'tok', isNewUser: false };
    mockAuthService.verifyOtp.mockReturnValue(expectedPayload);
    const input: VerifyOtpInput = { phone: '+919812300000', code: '123456' };

    const result = resolver.verifyOtp(input);

    expect(mockAuthService.verifyOtp).toHaveBeenCalledWith(
      '+919812300000',
      '123456',
    );
    expect(result).toBe(expectedPayload);
  });

  it('completeOnboarding() delegates the whole input object unchanged', () => {
    const expectedPayload = { accessToken: 'tok', isNewUser: false };
    mockAuthService.completeOnboarding.mockReturnValue(expectedPayload);
    const input: CompleteOnboardingInput = {
      onboardingToken: 'onb-tok',
      userName: 'Org Owner',
      organization: { name: 'Acme', type: 'BUYER' },
    };

    const result = resolver.completeOnboarding(input);

    expect(mockAuthService.completeOnboarding).toHaveBeenCalledWith(input);
    expect(result).toBe(expectedPayload);
  });
});
