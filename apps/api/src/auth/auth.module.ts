import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthResolver } from './auth.resolver';
import { OtpStoreService } from './otp-store.service';
import { SmsService } from './sms.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // getOrThrow, not get(..., 'dev-secret-change-me') -- a hardcoded
      // fallback here meant a real deployment with JWT_SECRET simply
      // unset would silently sign and verify every token with a public,
      // well-known string instead of failing to start. Every real
      // invocation path already sets this explicitly (.env.example /
      // docker-compose.yml for local dev, ci.yml's `cp .env.example .env`
      // for CI, .env.test for e2e tests, Render's own dashboard-managed
      // secret in prod per render.yaml) -- the fallback only ever existed
      // to paper over a genuinely missing config value, which should fail
      // loudly instead.
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  providers: [
    AuthService,
    AuthResolver,
    OtpStoreService,
    SmsService,
    JwtAuthGuard,
    RolesGuard,
  ],
  // JwtModule (for JwtService) + the guards, so other modules can
  // @UseGuards(JwtAuthGuard, RolesGuard) by importing AuthModule.
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
