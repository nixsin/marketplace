import { INestApplication } from '@nestjs/common';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertConnectedToTestDatabase } from './assert-test-database';

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  moduleFixture: TestingModule;
}

/**
 * Boots a real Nest app against the test database, configured exactly the way
 * production is.
 *
 * `configureApp` already exists to stop the test app and the real one drifting
 * apart, and its own comment says so. Six suites bootstrapped by hand anyway,
 * and two of them had already drifted: `auth` and `organizations` replicated
 * only its first line -- the ValidationPipe -- and so ran without the
 * correlation middleware, the correlation exception filter, the CORS policy
 * and the GraphQL cache-control patch. Anything those four do was untested in
 * exactly the two suites that exercise authentication.
 *
 * A hand-written bootstrap is what allowed that, so there is one here instead.
 *
 * `override` is for suites that must replace a provider before compiling --
 * the SMS sender, so no test sends a real message. It takes the builder rather
 * than a list of providers because `overrideProvider(X).useValue(y)` is a
 * two-call chain that does not survive being flattened into data.
 */
export async function bootstrapTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const moduleFixture = await (
    override ? override(builder) : builder
  ).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();

  // EVERYTHING from here is inside the cleanup path, not just the database
  // check. Once createNestApplication has returned there is something holding
  // resources, and the caller does not have it: on any throw their `beforeAll`
  // fails, `app` stays undefined, and their `afterAll` cannot close what it
  // was never given. Jest then hangs on the open Nest and Prisma handles and
  // reports THAT -- burying "you are pointed at the wrong database", which is
  // the most important message this file emits.
  try {
    configureApp(app);
    await app.init();

    // Never the dev database. The suites TRUNCATE between tests, and pointing
    // that at a real catalogue has destroyed local data before -- CLAUDE.md
    // has the incident.
    const prisma = moduleFixture.get(PrismaService);
    await assertConnectedToTestDatabase(prisma);

    return { app, prisma, moduleFixture };
  } catch (error) {
    // A failed close must not replace the reason we are here. Closing an app
    // that threw during init can itself throw, and that error is the less
    // useful of the two by far.
    await app.close().catch(() => undefined);
    throw error;
  }
}
