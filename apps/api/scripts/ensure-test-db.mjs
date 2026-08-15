// Creates the database DATABASE_URL points at if it doesn't already exist.
// `prisma migrate deploy` (run right after this, see test:e2e:migrate)
// applies schema *inside* a database — it doesn't create the database
// itself, and neither did anything else in this pipeline, which is
// exactly the gap that let a fresh Postgres (no dev history to inherit
// medinstru_test from) break `pnpm test:e2e` with no obvious cause.
//
// Connects to the `postgres` maintenance database (always present) rather
// than the target database, since the target may not exist yet — the
// same reason `createdb`/`CREATE DATABASE` always run against a
// different, already-existing database.
import { Client } from "pg";

const targetUrl = new URL(process.env.DATABASE_URL);
const dbName = targetUrl.pathname.slice(1);

const maintenanceUrl = new URL(targetUrl);
maintenanceUrl.pathname = "/postgres";

const client = new Client({ connectionString: maintenanceUrl.toString() });
await client.connect();

try {
  await client.query(`CREATE DATABASE "${dbName}"`);
  console.log(`Created database "${dbName}".`);
} catch (err) {
  // 42P04 = duplicate_database — already exists, which is the expected
  // outcome on every run after the first. Anything else is a real problem
  // (bad credentials, unreachable host, etc.) and should still fail loudly.
  if (err.code === "42P04") {
    console.log(`Database "${dbName}" already exists — skipping.`);
  } else {
    throw err;
  }
} finally {
  await client.end();
}
