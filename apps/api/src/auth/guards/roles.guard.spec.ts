// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function createMockContext(req: unknown): ExecutionContext {
  // GqlExecutionContext.create() calls context.getArgs() and rewraps the
  // result as [root, args, context, info] — index 2 is the GraphQL context,
  // whose `.req` this guard reads.
  return {
    getArgs: () => [undefined, undefined, { req }, undefined],
    getArgByIndex: (index: number) => (index === 2 ? { req } : undefined),
    getType: () => 'graphql',
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let mockReflector: { getAllAndOverride: jest.Mock };

  beforeEach(() => {
    mockReflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(mockReflector as unknown as Reflector);
  });

  it('passes through (returns true) when no @Roles() decorator is present (undefined)', () => {
    mockReflector.getAllAndOverride.mockReturnValue(undefined);
    // No req at all — proves the guard short-circuits before touching req.user.
    const context = createMockContext(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes through (returns true) when the required roles list is empty', () => {
    mockReflector.getAllAndOverride.mockReturnValue([]);
    const context = createMockContext(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('returns true when req.user.role matches the single required role', () => {
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    const req = { user: { sub: 'user-1', orgId: 'org-1', role: 'ADMIN' } };
    const context = createMockContext(req);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws ForbiddenException mentioning the required role when req.user.role does not match', () => {
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    const req = { user: { sub: 'user-1', orgId: 'org-1', role: 'STAFF' } };
    const context = createMockContext(req);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(/ADMIN/);
  });

  it('returns true when req.user.role matches any one of multiple allowed roles', () => {
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN', 'STAFF']);
    const req = { user: { sub: 'user-1', orgId: 'org-1', role: 'STAFF' } };
    const context = createMockContext(req);

    expect(guard.canActivate(context)).toBe(true);
  });
});
