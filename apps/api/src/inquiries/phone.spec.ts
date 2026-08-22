import { isE164 } from './phone';

describe('isE164', () => {
  it.each(['+919876543210', '+14155552671', '+441234567890'])(
    'accepts %s',
    (value) => expect(isE164(value)).toBe(true),
  );

  it.each<[string, string]>([
    ['0919876543210', 'no leading plus'],
    ['+0919876543', 'leading zero after the plus'],
    ['+91987', 'too short'],
    ['+9198765432101234', 'too long'],
    ['+91 98765 43210', 'contains spaces'],
    ['', 'empty'],
  ])('rejects %s (%s)', (value) => expect(isE164(value)).toBe(false));
});
