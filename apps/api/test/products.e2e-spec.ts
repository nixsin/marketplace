import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsService } from '../src/products/products.service';
import { configureApp } from '../src/app.setup';
import { assertConnectedToTestDatabase } from './helpers/assert-test-database';
import { graphqlCacheControl } from '../src/graphql-cache';

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
  let products: ProductsService;

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
    products = moduleFixture.get(ProductsService);
    await assertConnectedToTestDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Product", "License", "User", "Organization" RESTART IDENTITY CASCADE',
    );
    // The service memoises COUNT(*) for a minute, and that memo outlives a
    // TRUNCATE -- the instance is built once in beforeAll. Without this,
    // a test that changes how many products exist reads the previous
    // test's count. Proven by the totalCount test below, which fails with
    // `1` instead of `3` when this line is removed.
    products.invalidateProductCount();
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

    // Asserted against the shared constant rather than a literal, so the
    // header and its test cannot drift apart -- this assertion held a
    // stale literal and failed the moment s-maxage was added, which is
    // the right failure but the wrong reason to have to edit a test.
    expect(res.headers['cache-control']).toBe(graphqlCacheControl());

    // The semantics, spelled out, because the string alone does not say
    // which cache each directive is for:
    //   max-age=0    the browser -- always revalidates
    //   s-maxage     shared caches only -- lets a CDN serve without a hop
    //   SWR          serve stale instantly, refresh behind it
    expect(res.headers['cache-control']).toContain('max-age=0');
    expect(res.headers['cache-control']).toContain('s-maxage=');
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=');

    expect(res.headers.etag).toBeTruthy();
    expect(res.body.data.productsPaged.items).toHaveLength(1);
  });

  it('returns 304 on a conditional re-request with a matching ETag', async () => {
    const first = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: QUERY })
      .expect(200);

    const revalidated = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .set('If-None-Match', first.headers.etag)
      .query({ query: QUERY })
      .expect(304);

    // The 304 must carry the same caching policy as the 200 it
    // revalidates. Express builds a 304 by blanking the body and
    // stripping the Content-* headers, so a Cache-Control decided from
    // the FINAL response would see an empty body and refuse it -- which
    // is why the decision is made in res.send, before that transform.
    // Without this, a shared cache revalidating every s-maxage seconds
    // would be told `no-store` and drop the entry it just confirmed was
    // still fresh, turning cheap revalidation into a permanent miss.
    expect(revalidated.headers['cache-control']).toBe(graphqlCacheControl());
  });

  it('reports a totalCount that matches the rows actually present', async () => {
    // Placed AFTER the ETag tests deliberately: they query productsPaged and
    // so warm the memoised COUNT(*) with a value of 1. This is the only test
    // that changes how many products exist, so it is the one that would read
    // that stale 1 if the beforeEach did not invalidate. Ordering is what
    // makes it discriminating -- run first, against a cold memo, it would
    // pass either way and prove nothing.
    const seller = await prisma.organization.findFirstOrThrow();
    await prisma.product.createMany({
      data: [2, 3].map((n) => ({
        name: `Extra ${n}`,
        brand: 'MedTech',
        category: 'Diagnostic Imaging',
        location: 'Chennai, TN',
        sellerId: seller.id,
      })),
    });

    const res = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: QUERY })
      .expect(200);

    expect(res.body.data.productsPaged.totalCount).toBe(3);
  });

  it('does not override Cache-Control on POST — mutations/POST queries stay uncacheable', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: QUERY })
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not mark a resolver error cacheable, though it is an HTTP 200', async () => {
    // The core regression test. GraphQL reports a failed resolver as
    // HTTP 200 with an `errors` array, so a cache that trusts the status
    // line alone cannot tell this from a real product. Behind a CDN that
    // would pin a transient failure at the edge for s-maxage and then
    // keep serving it for the whole stale-while-revalidate window on
    // top, to everyone routed through that location -- with no purge
    // hook to cut it short.
    const res = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: 'query { product(id: "does-not-exist") { id } }' })
      .expect(200);

    // Proves the precondition rather than assuming it: this really is a
    // 200 carrying errors, which is what makes the header wrong.
    expect(res.body.errors).toBeDefined();
    expect(res.body.data).toBeNull();

    // Apollo's own default survives untouched, so nothing stores it.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cache-control']).not.toContain('s-maxage');
  });

  it('does not mark a malformed query cacheable', async () => {
    // A validation failure answers 4xx, but the old wrapper replaced the
    // header regardless of status -- confirmed live, a 400 came back
    // carrying the full s-maxage value.
    const res = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: 'query { productsPaged(page: 1) { nope } }' })
      .expect(400);

    expect(res.headers['cache-control']).not.toContain('s-maxage');
  });

  it('still exposes timing data on a failed request', async () => {
    // Timing-Allow-Origin is deliberately NOT tied to cacheability:
    // browsers zero out cross-origin timing data without it, and a
    // failing request is exactly the one worth measuring from RUM.
    const res = await request(app.getHttpServer())
      .get('/graphql')
      .set('apollo-require-preflight', 'true')
      .query({ query: 'query { product(id: "does-not-exist") { id } }' })
      .expect(200);

    expect(res.headers['timing-allow-origin']).toBe('*');
  });
});
