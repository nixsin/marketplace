import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SmsService } from '../src/auth/sms.service';
import { assertConnectedToTestDatabase } from './helpers/assert-test-database';

// This suite exists to close a real gap: JwtAuthGuard/RolesGuard were only
// unit-tested against a hand-mocked ExecutionContext (see
// jwt-auth.guard.spec.ts / roles.guard.spec.ts) — nothing proved the guard
// is actually wired up correctly on a real HTTP request (real header
// parsing, real JWT verification, @UseGuards actually applied to the
// resolver). This exercises myOrganization, the one guarded query that
// currently exists, end to end.
class FakeSmsService {
  sentCodes = new Map<string, string>();

  sendOtp(phone: string, code: string): void {
    this.sentCodes.set(phone, code);
  }
}

function gql(app: INestApplication<App>, token?: string) {
  return (query: string, variables?: Record<string, unknown>) => {
    const req = request(app.getHttpServer())
      .post('/graphql')
      .send({ query, variables });
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.expect(200);
  };
}

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
const MY_ORGANIZATION = `
  query MyOrganization {
    myOrganization { id name type kycStatus }
  }
`;

describe('Organizations (e2e)', () => {
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
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );
    fakeSms.sentCodes.clear();
  });

  // Runs the real signup flow to get back a genuine session accessToken —
  // not a hand-crafted JWT — so this proves the whole chain end to end:
  // OTP -> onboarding -> the resulting token actually authenticates.
  async function signUp(phone: string, orgName: string) {
    await gql(app)(REQUEST_OTP, { input: { phone } });
    const code = fakeSms.sentCodes.get(phone)!;
    const verify = await gql(app)(VERIFY_OTP, { input: { phone, code } });
    const onboardingToken = verify.body.data.verifyOtp.accessToken as string;

    const onboard = await gql(app)(COMPLETE_ONBOARDING, {
      input: {
        onboardingToken,
        userName: 'Org Owner',
        organization: { name: orgName, type: 'BUYER' },
      },
    });
    return {
      sessionToken: onboard.body.data.completeOnboarding.accessToken as string,
      onboardingToken,
    };
  }

  it("returns the caller's own organization for a valid session token", async () => {
    const { sessionToken } = await signUp('+919812300001', 'Zenith Surgicals');

    const res = await gql(app, sessionToken)(MY_ORGANIZATION);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.myOrganization).toMatchObject({
      name: 'Zenith Surgicals',
      type: 'BUYER',
      kycStatus: 'PENDING',
    });

    const org = await prisma.organization.findFirst({
      where: { name: 'Zenith Surgicals' },
    });
    expect(res.body.data.myOrganization.id).toBe(org?.id);
  });

  it("scopes strictly to the caller's own org, not a different one", async () => {
    const orgA = await signUp('+919812300002', 'Org A Diagnostics');
    await signUp('+919812300003', 'Org B Instruments');

    const res = await gql(app, orgA.sessionToken)(MY_ORGANIZATION);

    expect(res.body.data.myOrganization.name).toBe('Org A Diagnostics');
  });

  it('rejects the request with no Authorization header at all', async () => {
    const res = await gql(app)(MY_ORGANIZATION);

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/missing bearer token/i);
  });

  it('rejects a garbage/invalid bearer token', async () => {
    const res = await gql(app, 'not-a-real-jwt')(MY_ORGANIZATION);

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/invalid or expired token/i);
  });

  it('rejects the narrowly-scoped onboarding token — it proves phone verification, not a session', async () => {
    const { onboardingToken } = await signUp('+919812300004', 'Org C Devices');

    const res = await gql(app, onboardingToken)(MY_ORGANIZATION);

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/not a session token/i);
  });
});
