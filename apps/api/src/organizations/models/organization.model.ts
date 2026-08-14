import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { OrgType, KycStatus } from '../../../generated/prisma/enums';

registerEnumType(OrgType, { name: 'OrgType' });
registerEnumType(KycStatus, { name: 'KycStatus' });

@ObjectType()
export class Organization {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  gstin?: string;

  @Field(() => OrgType)
  type: OrgType;

  @Field(() => KycStatus)
  kycStatus: KycStatus;

  @Field()
  createdAt: Date;
}
