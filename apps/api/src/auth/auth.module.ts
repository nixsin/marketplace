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
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
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
