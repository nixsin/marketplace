import { readFileSync } from 'node:fs';
import { loadEnvFileIfPresent } from './boot-env';

/**
 * Every mention of `specifier`, paired with whether it is a deferred import.
 *
 * Deliberately NOT a matcher for the static import forms. Enumerating those
 * means hand-writing a JavaScript parser in a regex, and each round of that
 * found another form it missed -- named, default, side-effect, either quote
 * style, split across lines. Every miss is a silent pass on the one property
 * this file exists to protect.
 *
 * So the question is inverted. Rather than asking "does a static import
 * appear", which needs the complete list of ways to write one, it asks
 * "is every mention of app.module a deferred import" -- which needs only the
 * single form we require. Anything else, in any syntax, fails.
 */
function mentions(source: string, specifier: string) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The closing-quote lookahead is what makes this the module and not a
  // prefix of one: without it `./app.module-v2.js` reads as a mention of
  // `./app.module`, so renaming the module would satisfy a test whose whole
  // point is that this exact module stays deferred.
  return [
    ...source.matchAll(new RegExp(`${escaped}(\\.js)?(?=['"])`, 'g')),
  ].map((match) => ({
    deferred: /await import\(\s*['"]$/.test(source.slice(0, match.index ?? 0)),
  }));
}

/** Is `specifier` reached only through `await import(...)`? */
function onlyImportedDynamically(source: string, specifier: string) {
  const found = mentions(source, specifier);
  return found.length > 0 && found.every((m) => m.deferred);
}

describe('loadEnvFileIfPresent', () => {
  it('ignores a missing .env, which is the normal case on a deployment', () => {
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(() =>
      loadEnvFileIfPresent(() => {
        throw enoent;
      }),
    ).not.toThrow();
  });

  it('rethrows any other failure instead of reporting it as missing config', () => {
    // An unreadable or malformed .env swallowed here would surface as
    // "not declared" errors naming the variables that file actually sets,
    // sending whoever reads them after the wrong problem entirely.
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    expect(() =>
      loadEnvFileIfPresent(() => {
        throw denied;
      }),
    ).toThrow('permission denied');
  });

  it('rethrows an error carrying no code at all', () => {
    // A parse failure need not be an ErrnoException, so the check must not
    // assume `code` exists -- `undefined !== 'ENOENT'` has to rethrow.
    expect(() =>
      loadEnvFileIfPresent(() => {
        throw new Error('malformed .env');
      }),
    ).toThrow('malformed .env');
  });

  it('does nothing when the load succeeds', () => {
    let called = 0;
    loadEnvFileIfPresent(() => {
      called += 1;
    });
    expect(called).toBe(1);
  });
});

describe('main.ts boot ordering', () => {
  // Asserted against the SOURCE, because the property has no runtime handle:
  // by the time anything could observe it, the imports have already been
  // evaluated. The risk is real and quiet -- moving these two imports to the
  // top of the file reads like ordinary tidying, changes no test, and
  // silently restores the bug it was written to fix.
  //
  // ConfigModule.forRoot is an argument to AppModule's @Module decorator, so
  // it runs while app.module is being IMPORTED, not when Nest initialises.
  // A static import would therefore evaluate the whole provider tree before
  // the contract check could report anything.
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

  // BOTH deferred imports, not just app.module. app.setup pulls in the same
  // provider tree, so restoring a top-level import of it would defeat the
  // ordering just as completely — and guarding only the cited one is how a
  // fix satisfies a review while leaving its siblings open.
  it.each(['./app.module', './app.setup'])(
    'reaches %s only through a deferred import',
    (specifier) => {
      expect(onlyImportedDynamically(source, specifier)).toBe(true);
    },
  );

  it('does not treat a longer name as the module itself', () => {
    // `./app.module-v2` is a different module. Matching it would let a
    // rename quietly satisfy this whole describe block.
    expect(
      onlyImportedDynamically(
        "import { X } from './app.module-v2.js';",
        './app.module',
      ),
    ).toBe(false);
  });

  it.each([
    ["import { AppModule } from './app.module';", 'named, single quotes'],
    ['import { AppModule } from "./app.module.js";', 'named, double quotes'],
    // A side-effect import evaluates the module just as completely while
    // looking like it does nothing.
    ["import './app.module';", 'side-effect import'],
    ["import AppModule from './app.module';", 'default import'],
    ["import * as m from './app.module';", 'namespace import'],
    // Split across lines, which is how prettier would render a longer list.
    // A line-oriented matcher misses this one entirely.
    ["import {\n  AppModule,\n} from './app.module';", 'multiline import'],
  ])('rejects %s', (line) => {
    expect(onlyImportedDynamically(line, './app.module')).toBe(false);
  });

  it('accepts the deferred form, in either quote style', () => {
    expect(
      onlyImportedDynamically(
        "const { AppModule } = await import('./app.module.js');",
        './app.module',
      ),
    ).toBe(true);
    expect(
      onlyImportedDynamically(
        'const { AppModule } = await import("./app.module.js");',
        './app.module',
      ),
    ).toBe(true);
  });

  it('fails when the module is not mentioned at all', () => {
    // A rename that drops the deferred import must not read as compliant.
    expect(onlyImportedDynamically('const x = 1;', './app.module')).toBe(false);
  });

  it.each(['./app.module', './app.setup'])(
    'checks the environment before importing %s',
    (specifier) => {
      const check = source.indexOf('assertBootEnv({');
      expect(check).toBeGreaterThan(-1);

      // Quote-agnostic, like every other assertion here. Matching only the
      // single-quoted form made a valid double-quoted deferred import return
      // -1 from indexOf, failing the ordering test for a formatting choice
      // the tests above explicitly accept.
      const deferred = new RegExp(
        `await import\\(\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ).exec(source);
      expect(deferred).not.toBeNull();
      expect(check).toBeLessThan(deferred!.index);
    },
  );
});
