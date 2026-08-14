import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { AuthPayload } from './models/auth-payload.model';
import { RequestOtpInput } from './dto/request-otp.input';
import { VerifyOtpInput } from './dto/verify-otp.input';
import { CompleteOnboardingInput } from './dto/complete-onboarding.input';

@Resolver()
export class AuthResolver {
  constructor(private readonly auth: AuthService) {}

  @Mutation(() => Boolean)
  async requestOtp(@Args('input') input: RequestOtpInput) {
    const { sent } = await this.auth.requestOtp(input.phone);
    return sent;
  }

  @Mutation(() => AuthPayload)
  verifyOtp(@Args('input') input: VerifyOtpInput) {
    return this.auth.verifyOtp(input.phone, input.code);
  }

  @Mutation(() => AuthPayload)
  completeOnboarding(@Args('input') input: CompleteOnboardingInput) {
    return this.auth.completeOnboarding(input);
  }
}
