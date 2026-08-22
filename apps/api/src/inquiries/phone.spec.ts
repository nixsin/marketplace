import { isE164, normalizeE164, sanitizeTemplateParam } from './phone';

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

describe('normalizeE164', () => {
  it('canonicalises the way people actually write numbers', () => {
    // A form advertising "+91 98765 43210" while the sender rejects spaces
    // means a reasonable entry is stored and then fails at delivery -- which
    // the buyer only discovers by never getting a reply.
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
    // instead of storing an undeliverable number.
    expect(normalizeE164('not-a-number')).toBeNull();
    expect(normalizeE164('98765 43210')).toBeNull();
  });
});

describe('sanitizeTemplateParam', () => {
  it('flattens newlines and tabs', () => {
    // Meta rejects a parameter containing either -- and rejects the whole
    // message with it, not just the parameter.
    const flat = sanitizeTemplateParam('Product: X\nRef: p1\n\nFrom: Asha');
    expect(flat).not.toMatch(/[\r\n\t]/);
    expect(flat).toContain('Product: X');
    expect(flat).toContain('From: Asha');
  });

  it('collapses runs of whitespace and bounds the length', () => {
    expect(sanitizeTemplateParam('a      b')).toBe('a b');
    expect(sanitizeTemplateParam('x'.repeat(5000)).length).toBeLessThanOrEqual(
      1024,
    );
  });
});
