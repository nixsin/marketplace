import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthTokenPayload } from '../types/auth-token-payload';

export interface AuthenticatedRequest extends Request {
  user: AuthTokenPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = GqlExecutionContext.create(context)
      .getContext<{ req: AuthenticatedRequest }>()
      .req;

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: AuthTokenPayload & { scope?: string };
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Reject the narrowly-scoped onboarding token (see AuthService) — it
    // proves phone verification, not a real session, and lacks sub/orgId.
    if (!payload.sub || !payload.orgId) {
      throw new UnauthorizedException('Not a session token');
    }

    req.user = payload;
    return true;
  }
}
