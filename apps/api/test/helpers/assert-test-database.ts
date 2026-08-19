import { PrismaService } from '../../src/prisma/prisma.service';

// A real, programmatic guard -- not just the CLAUDE.md documentation of the
// incident this exists to prevent. A prior run of this e2e suite via
// `docker compose exec api pnpm test:e2e` truncated the real dev catalog:
// docker-compose.yml sets DATABASE_URL as a container-level env var, and
// dotenv's `config()` (loading .env.test) never overrides an already-set
// process.env value, so PrismaService silently connected to the dev
// database instead of medinstru_test. Queries the database Prisma is
// *actually* connected to, not process.env.DATABASE_URL as a string --
// this can't be fooled by whatever env-var indirection produced the
// connection, which is exactly the class of indirection that caused the
// original incident.
export async function assertConnectedToTestDatabase(
  prisma: PrismaService,
): Promise<void> {
  const [row] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    'SELECT current_database()',
  );
  const dbName = row.current_database;

  if (!dbName.includes('test')) {
    throw new Error(
      `Refusing to run destructive e2e setup (TRUNCATE) against database "${dbName}" -- ` +
        'it does not look like a test database (expected the name to contain "test"). ' +
        'This guard exists because this exact class of mistake already destroyed real ' +
        "dev data once -- see CLAUDE.md's docker-compose DATABASE_URL precedence gotcha.",
    );
  }
}
