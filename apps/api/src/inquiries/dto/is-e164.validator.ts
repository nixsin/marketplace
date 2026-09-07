import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { normalizeE164 } from '@medinstru/config';

/**
 * Accepts exactly what the service will accept, by asking the same function.
 *
 * The DTO used `@IsPhoneNumber()` while the service used `normalizeE164`, and
 * the two disagree in both directions. Measured, not assumed:
 *
 *   "+1 (555) 010-9999"   @IsPhoneNumber: false   normalizeE164: +15550109999
 *   "+999000000001"       @IsPhoneNumber: false   normalizeE164: +999000000001
 *
 * The second is not hypothetical -- `+999` is the ITU-reserved range the seed
 * writes for seller numbers, so the edge was rejecting values the rest of the
 * system treats as valid. Two layers disagreeing about what a phone number is
 * means the edge check tells you nothing about whether the service will accept
 * it, which is the opposite of what an edge check is for.
 *
 * Delegating rather than reimplementing is the point: `normalizeE164` is
 * already the shared cross-app contract (apps/web fingerprints idempotency
 * keys with it), so a change there cannot leave this behind.
 */
export function IsE164(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isE164',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && normalizeE164(value) !== null;
        },
        defaultMessage(args: ValidationArguments) {
          // Names the field, like every other constraint message, so the
          // caller is told which input to fix rather than that something was
          // wrong. See validation-error.ts for why that matters to a buyer.
          return `${args.property} must be a phone number including the country code`;
        },
      },
    });
  };
}
