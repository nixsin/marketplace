import { isE164, normalizeE164 } from './phone';

describe('isE164', () => {
  it.each(['+919876543210', '+14155552671', '+441234567890'])(
    'accepts %s',
    (value) => expect(isE164(value)).toBe(true),
  );

  it.each<[string, string]>([
    ['+2908123', 'Saint Helena, seven digits end to end'],
    ['+6821234', 'Cook Islands, seven digits'],
    ['+68312345', 'Niue, eight digits'],
  ])('accepts %s (%s)', (value) => {
    // A previous version required eight digits minimum, which E.164 does not
    // define. Because hasInquiryContact calls this directly, these sellers
    // would have silently appeared to have no contact number at all.
    expect(isE164(value)).toBe(true);
  });

  it.each<[string, string]>([
    ['+12', 'the shortest structurally valid form'],
    ['+123456789012345', 'exactly fifteen digits, the E.164 maximum'],
  ])('accepts the boundary %s (%s)', (value) =>
    expect(isE164(value)).toBe(true),
  );

  it('rejects one digit past the maximum', () => {
    expect(isE164('+1234567890123456')).toBe(false);
  });

  it.each<[string, string]>([
    ['0919876543210', 'no leading plus'],
    ['+0919876543', 'leading zero after the plus'],
    ['+9198765432101234', 'too long'],
    ['+1', 'a country code with no subscriber number'],
    ['+91 98765 43210', 'contains spaces'],
    ['', 'empty'],
  ])('rejects %s (%s)', (value) => expect(isE164(value)).toBe(false));
});

describe('normalizeE164', () => {
  it('canonicalises the way people actually write numbers', () => {
    for (const written of [
      '+91 98765 43210',
      '+91-98765-43210',
      '+91 (98765) 43210',
    ]) {
      expect(normalizeE164(written)).toBe('+919876543210');
    }
  });

  it('returns null for something that cannot be made valid', () => {
    // Null rather than a best guess: the caller rejects at the boundary
    // instead of storing a number that fails at delivery.
    expect(normalizeE164('not-a-number')).toBeNull();
    expect(normalizeE164('98765 43210')).toBeNull();
  });

  it('collapses the same number written differently to one value', () => {
    // Three spellings must be one rate-limit bucket, not three.
    const forms = ['+919876543210', '+91 98765 43210', '+91-98765-43210'];
    expect(new Set(forms.map(normalizeE164)).size).toBe(1);
  });
});
