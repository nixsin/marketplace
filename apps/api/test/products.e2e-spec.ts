import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { assertConnectedToTestDatabase } from './helpers/assert-test-database';

function gql(app: INestApplication<App>) {
  return (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/graphql')
      .send({ query, variables })
      .expect(200);
}

const PRODUCTS_QUERY = `
  query Products($cursor: String, $limit: Int) {
    products(cursor: $cursor, limit: $limit) {
      nextCursor
      items { id name seller { name } }
    }
  }
`;

// Automates what was manually curl-verified earlier: real cursor pagination
// against real Postgres, not just the mocked-Prisma unit tests.
describe('Products pagination (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sellerId: string;

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
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Product", "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );

    const seller = await prisma.organization.create({
      data: { name: 'Test Seller Co', type: 'SELLER' },
    });
    sellerId = seller.id;
  });

  async function seedProducts(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const p = await prisma.product.create({
        data: {
          sellerId,
          name: `Product ${i}`,
          brand: 'Test Brand',
          category: 'Test Category',
          certifications: [],
          location: 'Test City',
        },
      });
      ids.push(p.id);
    }
    return ids;
  }

  it('returns an empty page with no nextCursor when the catalog is empty', async () => {
    const res = await gql(app)(PRODUCTS_QUERY, { limit: 6 });

    expect(res.body.data.products.items).toEqual([]);
    expect(res.body.data.products.nextCursor).toBeNull();
  });

  it('paginates across two pages with no duplicates and correct termination', async () => {
    const seededIds = await seedProducts(10);

    const page1 = await gql(app)(PRODUCTS_QUERY, { limit: 6 });
    expect(page1.body.data.products.items).toHaveLength(6);
    expect(page1.body.data.products.nextCursor).not.toBeNull();

    const page2 = await gql(app)(PRODUCTS_QUERY, {
      limit: 6,
      cursor: page1.body.data.products.nextCursor,
    });
    expect(page2.body.data.products.items).toHaveLength(4);
    expect(page2.body.data.products.nextCursor).toBeNull();

    const page1Ids = page1.body.data.products.items.map(
      (i: { id: string }) => i.id,
    );
    const page2Ids = page2.body.data.products.items.map(
      (i: { id: string }) => i.id,
    );

    // No overlap between pages.
    expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([]);
    // Union of both pages is exactly the seeded set — nothing lost, nothing duplicated.
    expect([...page1Ids, ...page2Ids].sort()).toEqual([...seededIds].sort());
  });

  it('returns nextCursor: null when the result exactly fills one page', async () => {
    await seedProducts(6);

    const res = await gql(app)(PRODUCTS_QUERY, { limit: 6 });

    expect(res.body.data.products.items).toHaveLength(6);
    expect(res.body.data.products.nextCursor).toBeNull();
  });

  it('resolves the seller relation for each product', async () => {
    await seedProducts(1);

    const res = await gql(app)(PRODUCTS_QUERY, { limit: 6 });

    expect(res.body.data.products.items[0].seller.name).toBe('Test Seller Co');
  });
});

const PRODUCT_QUERY = `
  query Product($id: ID!) {
    product(id: $id) {
      id name details updatedAt
      seller { name gstin kycStatus }
    }
  }
`;

// Confirms end-to-end the exact shape the frontend's fetchProduct() needs to
// detect: a matched "not found" GraphQL error on an otherwise-200 response,
// not a 500 -- see products.resolver.ts's own comment for why product(id)
// is safe to expose unauthenticated in the first place.
describe('Product by id (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

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
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Product", "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );
  });

  it('returns the product with the seller relation resolved', async () => {
    const seller = await prisma.organization.create({
      data: {
        name: 'Detail Test Co',
        gstin: '29AAACD1234A1Z5',
        type: 'SELLER',
        kycStatus: 'APPROVED',
      },
    });
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Portable Ultrasound',
        brand: 'Test Brand',
        category: 'Diagnostic Imaging',
        certifications: [],
        location: 'Test City',
        details: { probeType: 'convex', displaySize: '7in' },
      },
    });

    const res = await gql(app)(PRODUCT_QUERY, { id: product.id });

    expect(res.body.data.product).toMatchObject({
      id: product.id,
      name: 'Portable Ultrasound',
      details: { probeType: 'convex', displaySize: '7in' },
      seller: {
        name: 'Detail Test Co',
        gstin: '29AAACD1234A1Z5',
        kycStatus: 'APPROVED',
      },
    });
    expect(res.body.data.product.updatedAt).toBeTruthy();
  });

  it('returns a GraphQL error, not a 500, for a nonexistent id', async () => {
    const res = await gql(app)(PRODUCT_QUERY, { id: 'does-not-exist' });

    expect(res.body.data).toBeNull();
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/not found/i);
  });
});

// Automates what was manually curl-verified: GraphQL-over-GET for the
// read-only productsPaged query, specifically so it can be conditionally
// cached (ETag/304) the way a POST request never can be under standard
// HTTP semantics — see the comment in app.setup.ts.
describe('GraphQL-over-GET caching (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const QUERY =
    'query { productsPaged(page: 1, pageSize: 2) { totalCount items { id name } } }';

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
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Product", "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );
    const seller = await prisma.organization.create({
      data: { name: 'Cache Test Co', type: 'SELLER' },
    });
    await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Cached Product',
        brand: 'B',
        category: 'C',
        certifications: [],
        location: 'L',
      },
    });
  });

  it('rejects a GET request without the CSRF-prevention header', async () => {
    // Confirms Apollo's CSRF protection is still active on this path —
    // GraphQL-over-GET without proof of a real fetch()/XHR call (which
    // enforces a CORS preflight) must stay blocked.
    await request(app.getHttpServer())
      .get('/graphql')
      .query({ query: QUERY })
      .expect(400);
  });

  it('answers GET with a cacheable Cache-Control and a real ETag', async () => {
    const res = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: QUERY })
      .expect(200);

    expect(res.headers['cache-control']).toBe(
      'public, max-age=0, must-revalidate',
    );
    expect(res.headers.etag).toBeTruthy();
    expect(res.body.data.productsPaged.items).toHaveLength(1);
  });

  it('returns 304 on a conditional re-request with a matching ETag', async () => {
    const first = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: QUERY })
      .expect(200);

    await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .set('If-None-Match', first.headers.etag)
      .query({ query: QUERY })
      .expect(304);
  });

  it('does not override Cache-Control on POST — mutations/POST queries stay uncacheable', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: QUERY })
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
  });
});
