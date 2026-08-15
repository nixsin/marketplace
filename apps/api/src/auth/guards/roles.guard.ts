import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedRequest } from './jwt-auth.guard';

// Always pair with @UseGuards(JwtAuthGuard, RolesGuard) in that order —
// this reads req.user, which only JwtAuthGuard populates.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest;
    }>().req;

    if (!requiredRoles.includes(req.user.role)) {
      throw new ForbiddenException(
        `Requires one of role(s): ${requiredRoles.join(', ')}`,
      );
    }
    return true;
  }
}
