import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { formatGraphqlError } from './graphql-error';
import { TooManyRequestsException } from './too-many-requests.exception';

/**
 * Every HTTP exception this codebase throws must map to a standard code.
 *
 * The trap this exists for is silent and was hit once already while writing
 * this: a `TooManyRequestsException` built from a bare string instead of
 * `HttpException.createBody` surfaced over GraphQL as INTERNAL_SERVER_ERROR --
 * a rate limit reported as a server fault. Every unit test passed. Nothing
 * about the throw site looked wrong.
 *
 * So this asserts the property end to end for each class actually used: build
 * the exception, take the status Nest gives it, and require formatGraphqlError
 * to turn that into a real code rather than leaving the generic one.
 */
const CONSTRUCTORS: Record<string, () => HttpException> = {
  BadRequestException: () => new BadRequestException('x'),
  ConflictException: () => new ConflictException('x'),
  ForbiddenException: () => new ForbiddenException('x'),
  NotFoundException: () => new NotFoundException('x'),
  UnauthorizedException: () => new UnauthorizedException('x'),
  TooManyRequestsException: () => new TooManyRequestsException('x'),
};

/** Every non-spec .ts under src. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.'))
      out.push(full);
  }
  return out;
}

function thrownExceptionNames(): string[] {
  const names = new Set<string>();
  // import.meta.dirname, not __dirname: this suite runs as ESM under
  // NestJS 12, where __dirname does not exist. See CLAUDE.md.
  for (const file of sourceFiles(import.meta.dirname)) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/throw new (\w*Exception)\b/g)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

describe('every thrown exception maps to a standard code', () => {
  const thrown = thrownExceptionNames();

  it('finds the exceptions to check', () => {
    // Guards the scan. A moved directory would otherwise make the whole block
    // vacuously green -- the same silent-pass shape this file exists to catch.
    expect(thrown.length).toBeGreaterThanOrEqual(5);
  });

  it('knows every exception class the codebase throws', () => {
    // A new exception type fails HERE, loudly, rather than degrading to
    // INTERNAL_SERVER_ERROR in production. Add it to CONSTRUCTORS and, if its
    // status is new, to CODE_BY_STATUS in graphql-error.ts.
    const unknown = thrown.filter((name) => !(name in CONSTRUCTORS));
    expect(unknown).toEqual([]);
  });

  it.each(Object.keys(CONSTRUCTORS))('%s produces a mapped code', (name) => {
    const exception = CONSTRUCTORS[name]();
    const status = exception.getStatus();

    // Shaped the way @nestjs/graphql hands it to Apollo: the generic code,
    // with the real status buried in originalError.
    const formatted = formatGraphqlError({
      message: exception.message,
      extensions: {
        code: 'BAD_REQUEST',
        originalError: { statusCode: status },
      },
    });

    expect(formatted.extensions?.code).not.toBe('BAD_REQUEST');
    expect(formatted.extensions?.originalError).toBeUndefined();
  });

  it('the body Nest builds is the shape the GraphQL layer reads', () => {
    // The actual bug from before: a plain-string body passes Nest's own
    // filters and then surfaces as INTERNAL_SERVER_ERROR over GraphQL. Every
    // exception here must produce the { message, error, statusCode } object
    // the built-ins produce.
    for (const name of Object.keys(CONSTRUCTORS)) {
      const response = CONSTRUCTORS[name]().getResponse();
      expect(typeof response).toBe('object');
      expect(response).toHaveProperty('statusCode');
    }
  });
});
