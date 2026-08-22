import { Field, ID, InputType } from '@nestjs/graphql';
import { IsPhoneNumber, IsString, Length, MinLength } from 'class-validator';
import {
  INQUIRY_MESSAGE_MAX_LENGTH,
  INQUIRY_NAME_MAX_LENGTH,
} from '@medinstru/config';

@InputType()
export class CreateInquiryInput {
  @Field(() => ID)
  @IsString()
  productId: string;

  @Field()
  @IsString()
  @Length(2, INQUIRY_NAME_MAX_LENGTH)
  buyerName: string;

  // IsPhoneNumber with no region forces E.164, which is what the provider
  // requires. Accepting a local format here would push the failure all the
  // way out to a rejected send.
  @Field()
  @IsPhoneNumber()
  buyerPhone: string;

  // Upper bound is not cosmetic: this is interpolated into an outbound
  // message body, so unbounded input is both an abuse vector and a way to
  // exceed the provider's own payload limit.
  @Field()
  @IsString()
  @MinLength(1)
  @Length(1, INQUIRY_MESSAGE_MAX_LENGTH)
  message: string;
}
