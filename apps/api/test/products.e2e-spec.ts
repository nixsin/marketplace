import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = moduleFixture.get(PrismaService);
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

    const page1Ids = page1.body.data.products.items.map((i: { id: string }) => i.id);
    const page2Ids = page2.body.data.products.items.map((i: { id: string }) => i.id);

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
