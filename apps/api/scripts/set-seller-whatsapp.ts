/**
 * Sets a seller organisation's WhatsApp number.
 *
 * WHY A SCRIPT AND NOT A MUTATION: nothing in this codebase can write
 * `Organization.whatsappNumber` today -- it is read by
 * `Product.hasInquiryContact` and by the delivery path, and written only by
 * the seed, which deliberately writes unroutable +999 numbers so a test run
 * can never message a stranger. So until seller onboarding exists, every
 * seller is uncontactable and the whole inquiry feature is inert no matter
 * how the provider is configured.
 *
 * A mutation would need authentication and an authorisation model, neither of
 * which exists yet, and inventing one for a single field would be the wrong
 * shape. A script run by someone who already has database credentials adds no
 * new exposure and is the same trust level as the seed.
 *
 * THIS WRITES A NUMBER THAT WILL RECEIVE REAL MESSAGES. It prints what it is
 * about to do and requires --yes, because the failure mode is messaging a
 * person who never agreed to it.
 *
 *   pnpm --filter api exec tsx scripts/set-seller-whatsapp.ts \
 *     --seller "MedTech Systems" --number "+91 98765 43210" --yes
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { normalizeE164 } from '@medinstru/config';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const sellerRef = arg('seller');
  const rawNumber = arg('number');
  const confirmed = process.argv.includes('--yes');

  if (!sellerRef || !rawNumber) {
    throw new Error(
      'Usage: --seller "<name or id>" --number "<E.164>" [--yes]\n' +
        'The number may be written with spaces, hyphens or parentheses.',
    );
  }

  // The SAME canonicalisation the delivery path uses, from the shared
  // package. A number stored in any other shape makes the seller look
  // uncontactable to Product.hasInquiryContact -- which is exactly the silent
  // failure this whole feature has already had once.
  const number = normalizeE164(rawNumber);
  if (!number) {
    throw new Error(
      `"${rawNumber}" is not a valid phone number. Include the country code, ` +
        'for example +91 98765 43210.',
    );
  }

  const seller = await prisma.organization.findFirst({
    where: { OR: [{ id: sellerRef }, { name: sellerRef }], type: 'SELLER' },
    select: { id: true, name: true, whatsappNumber: true },
  });
  if (!seller) {
    // Matched EXACTLY, not fuzzily: writing the wrong seller's number means
    // buyers' details going to a business that never asked for them. Listing
    // the candidates keeps that strictness from being merely annoying.
    const sellers = await prisma.organization.findMany({
      where: { type: 'SELLER' },
      select: { name: true, whatsappNumber: true },
      orderBy: { name: 'asc' },
    });
    throw new Error(
      `No SELLER organisation matches "${sellerRef}". Known sellers:\n` +
        sellers
          .map((s) => `  ${s.name} (${s.whatsappNumber ?? 'no number'})`)
          .join('\n'),
    );
  }

  const productCount = await prisma.product.count({
    where: { sellerId: seller.id },
  });

  console.log(`Seller:   ${seller.name} (${seller.id})`);
  console.log(`Current:  ${seller.whatsappNumber ?? '(none)'}`);
  console.log(`New:      ${number}`);
  console.log(
    `Effect:   ${productCount} product(s) become contactable, and inquiries ` +
      `about them will be sent to this number.`,
  );

  if (!confirmed) {
    console.log('\nNothing written. Re-run with --yes to apply.');
    return;
  }

  await prisma.organization.update({
    where: { id: seller.id },
    data: { whatsappNumber: number },
  });
  console.log('\nUpdated.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
