import { Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { Organization } from './models/organization.model';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthTokenPayload } from '../auth/types/auth-token-payload';

// createOrganization/organization(id) were removed: the former was an
// unauthenticated mutation letting anyone create arbitrary organizations
// (organizations should only be created via AuthService.completeOnboarding,
// which ties creation to a phone-verified user), and the latter let anyone
// fetch any org's KYC status by guessing an id. myOrganization replaces
// both — scoped to the caller's own org via their JWT, nothing else.
@Resolver(() => Organization)
export class OrganizationsResolver {
  constructor(private readonly organizations: OrganizationsService) {}

  @Query(() => Organization)
  @UseGuards(JwtAuthGuard)
  myOrganization(@CurrentUser() user: AuthTokenPayload) {
    return this.organizations.findById(user.orgId);
  }
}
