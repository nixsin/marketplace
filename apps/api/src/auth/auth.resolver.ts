import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthPayload } from './models/auth-payload.model';
import { User } from './models/user.model';
import { RequestOtpInput } from './dto/request-otp.input';
import { VerifyOtpInput } from './dto/verify-otp.input';
import { CompleteOnboardingInput } from './dto/complete-onboarding.input';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthTokenPayload } from './types/auth-token-payload';

@Resolver()
export class AuthResolver {
  constructor(private readonly auth: AuthService) {}

  @Query(() => User)
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthTokenPayload) {
    return this.auth.getUserById(user.sub);
  }

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
