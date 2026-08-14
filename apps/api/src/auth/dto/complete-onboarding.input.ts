import { Field, InputType } from '@nestjs/graphql';
import { IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateOrganizationInput } from '../../organizations/dto/create-organization.input';

@InputType()
export class CompleteOnboardingInput {
  @Field()
  @IsString()
  onboardingToken: string;

  @Field()
  @IsString()
  @MinLength(2)
  userName: string;

  @Field(() => CreateOrganizationInput)
  @ValidateNested()
  @Type(() => CreateOrganizationInput)
  organization: CreateOrganizationInput;
}
