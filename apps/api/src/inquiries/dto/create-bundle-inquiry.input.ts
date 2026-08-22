import { Field, ID, InputType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsPhoneNumber,
  IsString,
  Length,
  MinLength,
} from 'class-validator';
import {
  INQUIRY_BULK_MAX_PRODUCTS,
  INQUIRY_MESSAGE_MAX_LENGTH,
  INQUIRY_NAME_MAX_LENGTH,
} from '@medinstru/config';

@InputType()
export class CreateBundleInquiryInput {
  // Bounded at the boundary as well as in the service. An unbounded array is
  // an amplification vector: every extra id is another row written and
  // another line in an outbound message.
  @Field(() => [ID])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INQUIRY_BULK_MAX_PRODUCTS)
  @IsString({ each: true })
  productIds: string[];

  @Field()
  @IsString()
  @Length(2, INQUIRY_NAME_MAX_LENGTH)
  buyerName: string;

  @Field()
  @IsPhoneNumber()
  buyerPhone: string;

  @Field()
  @IsString()
  @MinLength(1)
  @Length(1, INQUIRY_MESSAGE_MAX_LENGTH)
  message: string;
}
