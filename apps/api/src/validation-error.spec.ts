import type { ValidationError } from '@nestjs/common';
import { validationException } from './validation-error';

const error = (
  property: string,
  constraints?: Record<string, string>,
  children?: ValidationError[],
): ValidationError => ({ property, constraints, children });

describe('validationException', () => {
  it('names the field and the constraint', () => {
    // The whole point. Without this the caller receives the string "Bad
    // Request Exception" and nothing else -- and apps/web picks the buyer's
    // copy from that message, so the one failure they can act on showed
    // generic "something went wrong" copy.
    const exception = validationException([
      error('buyerPhone', {
        isPhoneNumber: 'buyerPhone must be a valid phone number',
      }),
    ]);
    expect(exception.message).toBe('buyerPhone must be a valid phone number');
  });

  it('reports every failing constraint, not just the first', () => {
    // A form with two mistakes should surface two, or the buyer fixes one and
    // is rejected again for the other.
    const exception = validationException([
      error('buyerName', { length: 'buyerName is too short' }),
      error('message', { isNotEmpty: 'message should not be empty' }),
    ]);
    expect(exception.message).toContain('buyerName is too short');
    expect(exception.message).toContain('message should not be empty');
  });

  it('descends into NESTED errors, which carry no constraints of their own', () => {
    // A nested DTO reports through `children`, so reading `constraints` alone
    // returns an empty list -- which produces an error saying nothing at all,
    // exactly the state this function exists to end. It would look like a
    // working validator right up until a nested input was used.
    const exception = validationException([
      error('input', undefined, [
        error('buyerPhone', { isPhoneNumber: 'buyerPhone must be valid' }),
      ]),
    ]);
    expect(exception.message).toBe('buyerPhone must be valid');
  });

  it('is still a 400, so the standard code is unchanged', () => {
    // The message improves; the classification must not drift with it.
    expect(validationException([error('x', { a: 'b' })]).getStatus()).toBe(400);
  });
});
