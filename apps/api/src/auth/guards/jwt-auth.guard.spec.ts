// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

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

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let mockJwtService: { verify: jest.Mock };

  beforeEach(() => {
    mockJwtService = { verify: jest.fn() };
    guard = new JwtAuthGuard(mockJwtService as unknown as JwtService);
  });

  it('throws UnauthorizedException when there is no Authorization header', () => {
    const req = { headers: {} };
    const context = createMockContext(req);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Missing bearer token');
  });

  it('throws UnauthorizedException when the Authorization header is not Bearer-prefixed', () => {
    const req = { headers: { authorization: 'Basic xyz' } };
    const context = createMockContext(req);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Missing bearer token');
  });

  it('accepts a valid bearer token, sets req.user, and returns true', () => {
    const payload = { sub: 'user-1', orgId: 'org-1', role: 'ADMIN' };
    mockJwtService.verify.mockReturnValue(payload);
    const req: { headers: { authorization: string }; user?: unknown } = {
      headers: { authorization: 'Bearer good.token.here' },
    };
    const context = createMockContext(req);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockJwtService.verify).toHaveBeenCalledWith('good.token.here');
    expect(req.user).toEqual(payload);
  });

  it('throws UnauthorizedException when jwt.verify throws (expired/invalid token)', () => {
    mockJwtService.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const req = { headers: { authorization: 'Bearer bad.token' } };
    const context = createMockContext(req);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow(
      'Invalid or expired token',
    );
  });

  it('throws UnauthorizedException when the payload is missing sub/orgId (onboarding token)', () => {
    mockJwtService.verify.mockReturnValue({
      phone: '+15551234567',
      scope: 'onboarding',
    });
    const req = { headers: { authorization: 'Bearer onboarding.token' } };
    const context = createMockContext(req);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Not a session token');
  });
});
