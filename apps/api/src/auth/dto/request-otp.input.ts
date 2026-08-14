import { Field, InputType } from '@nestjs/graphql';
import { IsPhoneNumber } from 'class-validator';

@InputType()
export class RequestOtpInput {
  @Field()
  @IsPhoneNumber('IN')
  phone: string;
}
