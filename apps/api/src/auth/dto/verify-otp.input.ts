import { Field, InputType } from '@nestjs/graphql';
import { IsPhoneNumber, Length } from 'class-validator';

@InputType()
export class VerifyOtpInput {
  @Field()
  @IsPhoneNumber('IN')
  phone: string;

  @Field()
  @Length(6, 6)
  code: string;
}
