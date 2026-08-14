import { Field, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { OrgType } from '../../../generated/prisma/enums';

@InputType()
export class CreateOrganizationInput {
  @Field()
  @IsString()
  @MinLength(2)
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  gstin?: string;

  @Field(() => OrgType)
  @IsEnum(OrgType)
  type: OrgType;
}
