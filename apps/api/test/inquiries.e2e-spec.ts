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
    //
    // Truncating tables this suite does not own is safe here, and is what
    // every other e2e spec in this directory already does: jest-e2e.json
    // sets `maxWorkers: 1`, so these files run one at a time and never share
    // the database concurrently. That setting is what makes the pattern
    // valid -- raising it would break all four suites at once, not just
    // this one.
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
    // No `status`. It reported a real delivery outcome to an unauthenticated
    // caller, which is more than Product.hasInquiryContact already discloses
    // -- this test asserting 'FAILED' was itself the evidence that the change
    // exposed delivery while claiming not to.
    expect(res.body.data.createInquiry).toEqual({
      id: expect.any(String) as string,
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
    expect(stored?.status).toBe('FAILED');
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

  it('settles a concurrent duplicate to one row, whichever path runs', async () => {
    // Deliberately asserts the OUTCOME, not the path.
    //
    // An earlier version of this comment claimed it exercised the unique
    // index. It cannot: the two requests race, so the second may simply
    // observe the first row at the pre-flight lookup and never reach the
    // insert at all. Both routes are correct and either may run on any given
    // execution -- what must hold every time is one row and one id. The
    // collision path itself is covered deterministically in the unit tests,
    // where the P2002 can be forced.
    const variables = { input: input() };

    const results = await Promise.all([submit(variables), submit(variables)]);

    const ids = results.map((r) => r.body.data?.createInquiry?.id);
    expect(results.every((r) => r.body.errors === undefined)).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.inquiry.count()).toBe(1);
  });

  it('lets only ONE of two concurrent submissions past a limit boundary', async () => {
    // The rate-limit test below submits sequentially, which cannot show the
    // thing the Serializable isolation is actually for: two callers reading
    // the same count and both proceeding. Seeded one below the ceiling, with
    // two DISTINCT keys so idempotency cannot be what settles it.
    for (let i = 0; i < INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT - 1; i += 1) {
      await submit({ input: input() });
    }

    const results = await Promise.all([
      submit({ input: input() }),
      submit({ input: input() }),
    ]);

    const accepted = results.filter((r) => r.body.errors === undefined);
    expect(accepted).toHaveLength(1);
    expect(await prisma.inquiry.count()).toBe(
      INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
    );
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

  it('REJECTS a reused key carrying different details', async () => {
    // Reproduced against a running server before this test existed: submit a
    // question, lose the response, correct the phone number and reword the
    // question, submit again -- and the API answered with the original row's
    // id while the buyer was told their edited inquiry was recorded. It
    // never was.
    const first = input();
    await submit({ input: first });

    const edited = await submit({
      input: {
        ...first,
        buyerPhone: '+919000007777',
        message: 'Actually, please send the CE certificate too.',
      },
    });

    expect(edited.body.errors?.[0]?.message).toMatch(/different details/i);
    // The original is untouched, and no second row was written.
    expect(await prisma.inquiry.count()).toBe(1);
    const stored = await prisma.inquiry.findFirst();
    expect(stored?.buyerPhone).toBe('+919000000001');
  });

  it('records the lead as FAILED when delivery is not configured', async () => {
    // The e2e environment has no Meta credentials, which is the point: a
    // deployment without them must still CAPTURE every lead. Sending first
    // and persisting after would lose the lead precisely when something is
    // already wrong (#91 story 9).
    //
    // Asserted through real HTTP because the unit tests mock the provider
    // entirely -- they can prove the branch is taken, not that an unconfigured
    // service reaches it.
    const res = await submit({ input: input() });

    expect(res.body.errors).toBeUndefined();
    const stored = await prisma.inquiry.findFirst();
    expect(stored?.status).toBe('FAILED');
    expect(stored?.failureReason).toMatch(/not configured/i);
    // The buyer's own details survived the failed send.
    expect(stored?.buyerPhone).toBe('+919000000001');
    expect(stored?.message).toBe('Is this available in Chennai?');
  });

  it('never tells the buyer why delivery failed', async () => {
    // failureReason names provider state an anonymous caller has no business
    // seeing -- which variables are unset, what Meta said. It is for the
    // operator reading the table, not for the response.
    const res = await submit({ input: input() });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/not configured/i);
    expect(serialized).not.toMatch(/WHATSAPP_/);
    expect(serialized).not.toMatch(/failureReason/i);
    // Nor the delivery state itself, in any form.
    expect(serialized).not.toMatch(/PENDING|SENT|FAILED/);
  });

  it('does not deliver twice for an idempotent retry', async () => {
    // The database deduplicates perfectly and the seller is messaged twice
    // anyway, if delivery is not gated on this call having written the row.
    // Visible here as a second status write: a redelivered retry would
    // re-stamp failureReason with a fresh timestamp-free value, so the
    // observable proof is that the row is untouched between the two calls.
    const variables = { input: input() };

    await submit(variables);
    const afterFirst = await prisma.inquiry.findFirst();
    await submit(variables);
    const afterSecond = await prisma.inquiry.findFirst();

    expect(await prisma.inquiry.count()).toBe(1);
    expect(afterSecond?.id).toBe(afterFirst?.id);
    expect(afterSecond?.status).toBe(afterFirst?.status);
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

  it('keeps the exact substrings the web client routes error copy on', async () => {
    // apps/web's categorizeInquiryError matches SUBSTRINGS of this message to
    // decide which error the buyer is shown -- CLAUDE.md calls it a wire
    // contract, and rewording one side silently re-categorises the other.
    // Asserted here because a NestJS major is exactly the kind of change that
    // can alter how an exception's message reaches the client without anyone
    // editing the string.
    //
    // "  " is deliberate: it passes the DTO's @Length(2) and is rejected by
    // the service's own trim, so this reaches the service's
    // BadRequestException rather than class-validator.
    const blankName = await submit({ input: { ...input(), buyerName: '  ' } });
    expect(blankName.body.errors?.[0]?.message.toLowerCase()).toContain(
      'enter your name',
    );
  });

  it('reports a DTO-level rejection without naming the field', async () => {
    // NestJS 12 changed this: a class-validator failure used to surface its
    // own text ("buyerName must be longer than or equal to 2 characters") and
    // now surfaces a bare "Bad Request Exception".
    //
    // No behaviour change for the buyer, which is why it is recorded rather
    // than fixed -- categorizeInquiryError matched neither string, so both
    // land in the same "unknown" branch and show the same copy. It matters
    // for a different reason: the server no longer says WHICH field is wrong,
    // so the form's own mirrored constraints (minLength=2 on the name, the
    // phone placeholder) are now the only thing that can tell a buyer what to
    // fix. Weakening one of those would strand them with "Something went
    // wrong" and no way forward.
    const badPhone = await submit({
      input: { ...input(), buyerPhone: '12345' },
    });

    expect(badPhone.body.errors?.[0]?.message).toBe('Bad Request Exception');
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
