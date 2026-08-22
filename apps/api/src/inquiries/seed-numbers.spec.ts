import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isE164 } from './phone';

/**
 * Seed data must never contain a routable phone number.
 *
 * The first version used +9198765000xx -- syntactically valid Indian mobile
 * numbers that may well belong to real people. Seeds run in CI and in
 * development, and the inquiry flow is public and unauthenticated, so one
 * seeded database in an environment holding Meta credentials would have sent
 * strangers real buyers' names, phone numbers and questions.
 *
 * +999 is an ITU-reserved country code assigned to no operator, so it passes
 * E.164 validation -- keeping the fixture useful -- while being undeliverable.
 */
describe('seeded WhatsApp numbers', () => {
  const seed = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'seed.ts'),
    'utf8',
  );
  const numbers = [...seed.matchAll(/whatsappNumber: '([^']+)'/g)].map(
    (m) => m[1],
  );

  it('seeds at least one number, or the fixture stops exercising the form', () => {
    expect(numbers.length).toBeGreaterThan(0);
  });

  it('uses ONLY the reserved, unroutable +999 range', () => {
    for (const number of numbers) {
      expect(number).toMatch(/^\+999/);
    }
  });

  it('still passes E.164, so hasInquiryContact stays true for them', () => {
    for (const number of numbers) expect(isE164(number)).toBe(true);
  });
});

describe('what the capability flag actually asserts', () => {
  it('is true for the reserved range, which is the point of the rename', () => {
    // The seeded +999 numbers are chosen BECAUSE they cannot route. They pass
    // E.164, so the flag is true for them -- which is exactly why the field is
    // called hasInquiryContact and not canReceiveInquiries. The old name
    // claimed reachability about numbers picked for being undeliverable.
    //
    // Real reachability needs the provider's own number verification, which
    // arrives with the delivery integration.
    expect(isE164('+99900000001')).toBe(true);
  });
});
