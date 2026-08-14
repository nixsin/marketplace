import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { OrganizationsService } from './organizations.service';
import { Organization } from './models/organization.model';
import { CreateOrganizationInput } from './dto/create-organization.input';

@Resolver(() => Organization)
export class OrganizationsResolver {
  constructor(private readonly organizations: OrganizationsService) {}

  @Query(() => Organization)
  organization(@Args('id', { type: () => ID }) id: string) {
    return this.organizations.findById(id);
  }

  @Mutation(() => Organization)
  createOrganization(@Args('input') input: CreateOrganizationInput) {
    return this.organizations.create(input);
  }
}
