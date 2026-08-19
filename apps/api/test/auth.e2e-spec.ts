import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SmsService } from '../src/auth/sms.service';
import { assertConnectedToTestDatabase } from './helpers/assert-test-database';

class FakeSmsService {
  sentCodes = new Map<string, string>();

  sendOtp(phone: string, code: string): void {
    this.sentCodes.set(phone, code);
  }
}

function gql(app: INestApplication<App>) {
  return (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({ query, variables })
      .expect(200);
}

describe('Auth + onboarding (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fakeSms: FakeSmsService;

  beforeAll(async () => {
    fakeSms = new FakeSmsService();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SmsService)
      .useValue(fakeSms)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    await assertConnectedToTestDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Isolate each test: real DB, wiped between runs.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );
    fakeSms.sentCodes.clear();
  });

  const REQUEST_OTP = `
    mutation RequestOtp($input: RequestOtpInput!) {
      requestOtp(input: $input)
    }
  `;
  const VERIFY_OTP = `
    mutation VerifyOtp($input: VerifyOtpInput!) {
      verifyOtp(input: $input) { accessToken isNewUser }
    }
  `;
  const COMPLETE_ONBOARDING = `
    mutation CompleteOnboarding($input: CompleteOnboardingInput!) {
      completeOnboarding(input: $input) { accessToken isNewUser }
    }
  `;

  it('runs the full new-user flow: request OTP -> verify -> onboard -> persisted in DB', async () => {
    const phone = '+919876543210';

    const requestRes = await gql(app)(REQUEST_OTP, { input: { phone } });
    expect(requestRes.body.data.requestOtp).toBe(true);

    const code = fakeSms.sentCodes.get(phone);
    expect(code).toMatch(/^\d{6}$/);

    const verifyRes = await gql(app)(VERIFY_OTP, {
      input: { phone, code },
    });
    expect(verifyRes.body.data.verifyOtp.isNewUser).toBe(true);
    const onboardingToken = verifyRes.body.data.verifyOtp.accessToken;

    const onboardRes = await gql(app)(COMPLETE_ONBOARDING, {
      input: {
        onboardingToken,
        userName: 'Test Buyer',
        organization: { name: 'Apollo Diagnostics Pvt Ltd', type: 'BUYER' },
      },
    });
    expect(onboardRes.body.data.completeOnboarding.isNewUser).toBe(false);
    expect(onboardRes.body.data.completeOnboarding.accessToken).toEqual(
      expect.any(String),
    );

    const org = await prisma.organization.findFirst({
      where: { name: 'Apollo Diagnostics Pvt Ltd' },
    });
    expect(org).not.toBeNull();
    expect(org?.type).toBe('BUYER');

    const user = await prisma.user.findUnique({ where: { phone } });
    expect(user?.name).toBe('Test Buyer');
    expect(user?.organizationId).toBe(org?.id);
    expect(user?.role).toBe('ADMIN');
  });

  it('recognizes a returning user on a second OTP verification', async () => {
    const phone = '+919876500000';

    // Onboard once.
    await gql(app)(REQUEST_OTP, { input: { phone } });
    let code = fakeSms.sentCodes.get(phone)!;
    const firstVerify = await gql(app)(VERIFY_OTP, { input: { phone, code } });
    await gql(app)(COMPLETE_ONBOARDING, {
      input: {
        onboardingToken: firstVerify.body.data.verifyOtp.accessToken,
        userName: 'Returning User',
        organization: { name: 'Second Org', type: 'SELLER' },
      },
    });

    // Log in again with the same phone.
    await gql(app)(REQUEST_OTP, { input: { phone } });
    code = fakeSms.sentCodes.get(phone)!;
    const secondVerify = await gql(app)(VERIFY_OTP, { input: { phone, code } });

    expect(secondVerify.body.data.verifyOtp.isNewUser).toBe(false);
  });

  it('rejects verification with a wrong OTP code', async () => {
    const phone = '+919876511111';
    await gql(app)(REQUEST_OTP, { input: { phone } });

    const res = await gql(app)(VERIFY_OTP, {
      input: { phone, code: '000000' },
    });

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/invalid or expired code/i);
  });

  it('rejects onboarding with a garbage token', async () => {
    const res = await gql(app)(COMPLETE_ONBOARDING, {
      input: {
        onboardingToken: 'not-a-real-token',
        userName: 'Someone',
        organization: { name: 'Ghost Org', type: 'BUYER' },
      },
    });

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/invalid or expired/i);

    const org = await prisma.organization.findFirst({
      where: { name: 'Ghost Org' },
    });
    expect(org).toBeNull();
  });

  it('rejects requestOtp for a non-Indian phone number (validation)', async () => {
    const res = await gql(app)(REQUEST_OTP, {
      input: { phone: 'not-a-phone-number' },
    });

    expect(res.body.errors).toBeDefined();
  });
});
