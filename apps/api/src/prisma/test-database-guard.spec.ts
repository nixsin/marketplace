import { isTestDatabaseName } from './test-database-guard';

describe('isTestDatabaseName', () => {
  it("accepts this repo's real test database name", () => {
    expect(isTestDatabaseName('medinstru_test')).toBe(true);
  });

  it('rejects the real dev database name', () => {
    expect(isTestDatabaseName('medinstru')).toBe(false);
  });

  it('rejects names that merely contain "test" as a substring', () => {
    // The exact false-positive gap a review round caught in an earlier,
    // more permissive .includes('test') version of this guard.
    expect(isTestDatabaseName('contest')).toBe(false);
    expect(isTestDatabaseName('latest')).toBe(false);
    expect(isTestDatabaseName('testing')).toBe(false);
    expect(isTestDatabaseName('protest_db')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isTestDatabaseName('')).toBe(false);
  });

  it('rejects a name that starts with "test" but does not end with "_test"', () => {
    expect(isTestDatabaseName('test_medinstru')).toBe(false);
  });
});
