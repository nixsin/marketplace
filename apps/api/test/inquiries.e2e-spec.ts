import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { assertConnectedToTestDatabase } from './helpers/assert-test-database';
import { INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT } from '@medinstru/config';

const CREATE_INQUIRY = `
  mutation CreateInquiry($input: CreateInquiryInput!) {
    createInquiry(input: $input) {
      id
      status
      createdAt
    }
  }
`;

/**
 * The inquiry mutation over real HTTP against real Postgres.
 *
 * The unit tests mock Prisma, so three of the things this feature actually
 * depends on are invisible to them: the unique index that enforces
 * idempotency (rather than the service's own lookup, which only avoids a
 * round trip), Serializable isolation behaving as expected on this database,
 * and the shape of what a GraphQL client really receives.
 */
describe('Inquiries (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let productId: string;

  const input = () => ({
    idempotencyKey: `e2e-${Math.random().toString(36).slice(2)}`,
    productId,
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Is this available in Chennai?',
  });

  function submit(variables: { input: Record<string, unknown> }) {
    return request(app.getHttpServer())
      .post('/graphql')
      .send({ query: CREATE_INQUIRY, variables })
      .expect(200);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    await assertConnectedToTestDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Inquiry is listed explicitly rather than left to CASCADE. It is not
    // optional: Inquiry.productId is ON DELETE RESTRICT, and a leftover row
    // from a previous test file would also be counted by the rate limits
    // below, failing them for reasons that have nothing to do with this file.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Inquiry", "Product", "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );

    const seller = await prisma.organization.create({
      data: {
        name: 'Test Seller Co',
        type: 'SELLER',
        // ITU-reserved +999, never routable. A real number here would mean a
        // test run that ends up wired to a provider messages a stranger.
        whatsappNumber: '+999000000001',
      },
    });
    const product = await prisma.product.create({
      data: {
        name: 'Portable Digital X-Ray Machine',
        brand: 'MedTech',
        category: 'Diagnostic Imaging',
        location: 'Chennai, TN',
        sellerId: seller.id,
      },
    });
    productId = product.id;
  });

  it('records an inquiry and returns nothing a caller could mine', async () => {
    const variables = { input: input() };
    const res = await submit(variables);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createInquiry).toEqual({
      id: expect.any(String) as string,
      status: 'PENDING',
      createdAt: expect.any(String) as string,
    });

    // The mutation is unauthenticated, so the response body is readable by
    // whoever called it. Asserted against the SERIALIZED response rather than
    // by naming fields, because the risk is a field nobody thought about.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('+999000000001');
    expect(serialized).not.toContain(variables.input.buyerPhone);
    expect(serialized).not.toContain(variables.input.message);

    const stored = await prisma.inquiry.findFirst();
    expect(stored?.buyerPhone).toBe('+919000000001');
    expect(stored?.status).toBe('PENDING');
  });

  it('canonicalises the phone number before it reaches the database', async () => {
    await submit({
      input: { ...input(), buyerPhone: '+91 90000 00002' },
    });

    const stored = await prisma.inquiry.findFirst();
    expect(stored?.buyerPhone).toBe('+919000000002');
  });

  it('returns the SAME inquiry for a repeated key, and writes one row', async () => {
    const variables = { input: input() };

    const first = await submit(variables);
    const second = await submit(variables);

    expect(second.body.errors).toBeUndefined();
    expect(second.body.data.createInquiry.id).toBe(
      first.body.data.createInquiry.id,
    );
    expect(await prisma.inquiry.count()).toBe(1);
  });

  it('lets the DATABASE settle a concurrent duplicate, not the lookup', async () => {
    // The service's findUnique only avoids a round trip in the common case.
    // Fired together, both requests pass it before either inserts, so what
    // actually prevents a second inquiry -- and, once delivery exists, a
    // second message to the seller -- is the unique index. A mocked Prisma
    // cannot prove that; this can.
    const variables = { input: input() };

    const results = await Promise.all([submit(variables), submit(variables)]);

    const ids = results.map((r) => r.body.data?.createInquiry?.id);
    expect(results.every((r) => r.body.errors === undefined)).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.inquiry.count()).toBe(1);
  });

  it('rejects an inquiry about a product that does not exist', async () => {
    const res = await submit({
      input: { ...input(), productId: 'no-such-product' },
    });

    expect(res.body.errors?.[0]?.message).toMatch(/not found/i);
    expect(await prisma.inquiry.count()).toBe(0);
  });

  it('enforces the per-phone-per-product limit from stored rows', async () => {
    // Counted from the Inquiry table rather than an in-process counter, which
    // would reset on deploy and be per-instance. Driven through real HTTP so
    // the count comes from rows this test actually created.
    for (let i = 0; i < INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT; i += 1) {
      const res = await submit({ input: input() });
      expect(res.body.errors).toBeUndefined();
    }

    const blocked = await submit({ input: input() });
    expect(blocked.body.errors?.[0]?.message).toMatch(
      /already sent inquiries/i,
    );
    expect(await prisma.inquiry.count()).toBe(
      INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
    );
  });

  it('rejects a name or message that is only whitespace', async () => {
    // @Length(2) accepts "  " and @MinLength(1) accepts " ", and this
    // mutation is public, so the form's own trim is not a control.
    const res = await submit({
      input: { ...input(), buyerName: '  ', message: ' ' },
    });

    expect(res.body.errors).toBeDefined();
    expect(await prisma.inquiry.count()).toBe(0);
  });

  it('never exposes the seller number through the product type either', async () => {
    // The number is reachable from Product.seller in the data model, so the
    // guard that matters is that no field surfaces it. hasInquiryContact is a
    // boolean for exactly this reason (#91 story 6).
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `{ product(id: "${productId}") { hasInquiryContact seller { name } } }`,
      })
      .expect(200);

    expect(res.body.data.product.hasInquiryContact).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('+999000000001');
  });
});
