import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isE164 } from './phone';

/**
 * Seed data must never contain a routable phone number.
 *
 * The first version used +9198765000xx -- syntactically valid Indian mobile
 * numbers that may well belong to real people. Seeds run in CI and in
 * development, and the inquiry flow is public and unauthenticated, so one
 * seeded database in an environment holding provider credentials would have
 * sent strangers real buyers' names, phone numbers and questions.
 *
 * +999 is an ITU-reserved country code assigned to no operator, so it passes
 * E.164 -- keeping the fixture useful -- while being undeliverable.
 *
 * SCANS FOR NUMBERS, NOT FOR ASSIGNMENTS. An earlier version matched
 * `whatsappNumber: '...'` and so ignored a double-quoted string, a template
 * literal or a variable -- a routable number introduced any of those ways
 * slipped through while these tests stayed green. It then over-corrected and
 * tripped on `whatsappNumber: null` in a where-clause, which is not a number
 * at all. What actually matters is whether a dialable number appears
 * ANYWHERE in the file, regardless of how it is written.
 */
describe('seeded phone numbers', () => {
  const seed = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'seed.ts'),
    'utf8',
  );

  /** Anything shaped like an international number, however it is written. */
  const numbers = [...seed.matchAll(/\+\d{6,}/g)].map((m) => m[0]);

  it('contains at least one, or the fixture stops exercising the form', () => {
    expect(numbers.length).toBeGreaterThan(0);
  });

  it('uses ONLY the reserved, unroutable +999 range', () => {
    // Fails closed: any dialable number in this file fails, whether it is a
    // literal, inside a template string, or in a comment someone might copy.
    expect(numbers.filter((n) => !n.startsWith('+999'))).toEqual([]);
  });

  it('still passes E.164, so hasInquiryContact stays true for them', () => {
    for (const number of numbers) expect(isE164(number)).toBe(true);
  });
});
