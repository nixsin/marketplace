import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { UserRole } from '../../../generated/prisma/enums';
import { Organization } from '../../organizations/models/organization.model';

registerEnumType(UserRole, { name: 'UserRole' });

@ObjectType()
export class User {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  phone: string;

  @Field({ nullable: true })
  email?: string;

  @Field(() => UserRole)
  role: UserRole;

  @Field(() => Organization)
  organization: Organization;
}
