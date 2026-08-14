import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { DeviceClass } from '../../../generated/prisma/enums';
import { Organization } from '../../organizations/models/organization.model';

registerEnumType(DeviceClass, { name: 'DeviceClass' });

@ObjectType()
export class Product {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  brand: string;

  @Field()
  category: string;

  @Field(() => DeviceClass, { nullable: true })
  deviceClass?: DeviceClass;

  @Field(() => [String])
  certifications: string[];

  @Field()
  location: string;

  @Field()
  description: string;

  @Field({ nullable: true })
  imageUrl?: string;

  @Field(() => Organization)
  seller: Organization;

  @Field()
  createdAt: Date;
}
