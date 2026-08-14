import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

// Only meaningful behind @UseGuards(JwtAuthGuard), which populates req.user.
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext) => {
    const req = GqlExecutionContext.create(context)
      .getContext<{ req: AuthenticatedRequest }>()
      .req;
    return req.user;
  },
);
