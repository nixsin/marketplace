// Pure predicate, deliberately separated from the DB-querying wrapper in
// apps/api/test/helpers/assert-test-database.ts so it's directly
// unit-testable (test-database-guard.spec.ts) without a live database
// connection.
//
// A plain `.includes('test')` substring check (an earlier version of this
// guard) would incorrectly let names like "contest" or "latest" through --
// a false positive that defeats the point of the guard, since the guarded
// e2e suites run an unconditional TRUNCATE CASCADE right after. Matching
// this repo's actual naming convention instead (medinstru_test, see
// .env.test) closes that gap without needing a separate configured
// allow-list.
export function isTestDatabaseName(name: string): boolean {
  return name.endsWith('_test');
}
