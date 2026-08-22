import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
  WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH,
} from '@medinstru/config';
import {
  InquiriesService,
  assertSameSubmission,
  buildInquiryMessage,
  buildInquirySummary,
  hashIp,
  publicSiteUrl,
  sanitizeForLog,
} from './inquiries.service';
import { WhatsappService, sanitizeTemplateParam } from './whatsapp.service';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { InquiryStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const PRODUCT = {
  id: 'seed-product-01',
  name: 'Portable Digital X-Ray Machine',
  sellerId: 'org-1',
  seller: { id: 'org-1', whatsappNumber: '+919876543210' },
};

// Generated, never a committed literal. scripts/lib/repo-hygiene.test.mjs
// scans tracked files for secret-shaped assignments and flagged the hardcoded
// value that used to be here -- correctly: a fixture that looks like a
// credential is indistinguishable from one at scan time, and the guard exists
// so a real key can never be committed unnoticed.
const TEST_IP_HASH_SECRET = randomBytes(24).toString('hex');

/**
 * A row as Prisma would return it for ARGS.
 *
 * Spelled out rather than mocked as `{ id, status }`, because the service
 * compares the stored payload against the incoming one -- a stub missing
 * those fields is not a row the code could ever have written, and it made
 * every idempotency test look like a mismatched key.
 */
const storedRowFor = (id: string, overrides: object = {}) => ({
  id,
  status: 'PENDING',
  productId: 'seed-product-01',
  buyerName: 'Asha Rao',
  buyerPhone: '+919000000001',
  message: 'Is this available in Chennai?',
  ...overrides,
});

const ARGS = {
  idempotencyKey: 'test-submission-key-0001',
  productId: 'seed-product-01',
  buyerName: 'Asha Rao',
  buyerPhone: '+919000000001',
  message: 'Is this available in Chennai?',
};

describe('buildInquiryMessage', () => {
  const message = buildInquiryMessage({
    productName: 'Portable Digital X-Ray Machine',
    productId: 'seed-product-01',
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Is this available in Chennai?',
    siteUrl: 'https://laxair.shop',
  });

  it('identifies the product without a round trip (#91 story 4)', () => {
    expect(message).toContain('Portable Digital X-Ray Machine');
    expect(message).toContain('seed-product-01');
  });

  it('carries the same canonical URL a buyer would share', () => {
    // A forwarded inquiry and a forwarded link must land on one page.
    expect(message).toContain(
      'https://laxair.shop/en/products/seed-product-01',
    );
  });

  it('does not double the slash when the site URL has a trailing one', () => {
    const trailing = buildInquiryMessage({
      productName: 'X',
      productId: 'p1',
      buyerName: 'B',
      buyerPhone: '+919000000001',
      message: 'hi',
      siteUrl: 'https://laxair.shop/',
    });
    expect(trailing).toContain('https://laxair.shop/en/products/p1');
    expect(trailing).not.toContain('shop//en');
  });

  it('keeps the contact line even when the product name is absurd', () => {
    // buildInquirySummary used to put "From: name (phone)" LAST, and
    // sanitizeTemplateParam truncates from the end. Product names are
    // unbounded String in the schema -- the seeded catalogue already has a
    // deliberately absurd one -- so a long enough name pushed the buyer's
    // name and phone off the end entirely. The seller then received an
    // inquiry with no way to reply, which is worse than receiving nothing:
    // it looks answerable and is not.
    const summary = buildInquirySummary({
      productName: 'X'.repeat(5000),
      productId: 'seed-product-01',
      buyerName: 'Asha Rao',
      buyerPhone: '+919000000001',
      siteUrl: 'https://laxair.shop',
    });
    const sent = sanitizeTemplateParam(summary);

    expect(sent).toContain('Asha Rao');
    expect(sent).toContain('+919000000001');
    // And the whole thing still fits its parameter, rather than relying on
    // nothing after the contact line mattering.
    expect(sent.length).toBeLessThanOrEqual(1024);
  });

  it('bounds the summary itself, not just what survives sanitising', () => {
    // Ordering alone protects the contact line, so this bound is belt-and-
    // braces -- which is exactly why it needs its own assertion. Without one,
    // removing the cap changes nothing observable and the guarantee silently
    // becomes "nothing after the contact line happened to matter".
    const summary = buildInquirySummary({
      productName: 'X'.repeat(5000),
      productId: 'seed-product-01',
      buyerName: 'Asha Rao',
      buyerPhone: '+919000000001',
    });

    // Fits its parameter BEFORE sanitizeTemplateParam does any truncating.
    expect(summary.length).toBeLessThanOrEqual(
      WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH,
    );
    // And the name was shortened rather than the line dropped.
    expect(summary).toContain('Product: ');
    expect(summary).toContain('\u2026');
  });

  it('puts the contact line before the product details', () => {
    const summary = buildInquirySummary({
      productName: 'X-Ray',
      productId: 'p1',
      buyerName: 'Asha Rao',
      buyerPhone: '+919000000001',
    });
    expect(summary.indexOf('Asha Rao')).toBeLessThan(summary.indexOf('X-Ray'));
  });

  it('includes how to reach the buyer back', () => {
    expect(message).toContain('Asha Rao');
    expect(message).toContain('+919000000001');
  });
});

describe('sanitizeForLog', () => {
  // Provider text is external input, and this function exists so it cannot
  // forge a log entry. Three classes had to be covered, and each was missed
  // in turn -- so they are asserted by CODE POINT here rather than by pasting
  // characters into a string literal, where a shell or an editor can silently
  // normalise them (which it did, hiding an earlier fix that had not applied
  // at all).
  it.each([
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
    ['U+000A LINE FEED', 0x000a],
    ['U+0009 TAB', 0x0009],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['U+0000 NUL', 0x0000],
  ])('removes %s', (_label, code) => {
    const ch = String.fromCharCode(code);
    expect(sanitizeForLog(`before${ch}after`)).not.toContain(ch);
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeForLog('provider 400: invalid recipient')).toBe(
      'provider 400: invalid recipient',
    );
  });

  it('bounds the length, ellipsising rather than cutting silently', () => {
    const out = sanitizeForLog('x'.repeat(500), 200);
    expect(out).toHaveLength(200);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('does not split a surrogate pair when it truncates', () => {
    // The THIRD instance of this class. The template parameter and the
    // product name were fixed together; this one was missed, which is what
    // "fix the class, not the cited instance" is supposed to prevent.
    // Provider error text is the likeliest of the three to carry a non-BMP
    // character, since it can echo arbitrary input back.
    const out = sanitizeForLog('x'.repeat(199) + '\u{1F600}'.repeat(10), 200);
    const unpaired =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(unpaired.test(out)).toBe(false);
  });
});

describe('publicSiteUrl', () => {
  // SITE_URL falls back to http://localhost:3000, and render.yaml declares
  // NEXT_PUBLIC_SITE_URL only for the WEB service -- so the API resolves that
  // fallback in production and every seller would have received
  // `Link: http://localhost:3000/en/products/...`. Verified by importing the
  // config with the variable unset before this existed.
  it.each([
    ['http://localhost:3000', 'the development fallback'],
    ['http://127.0.0.1:3000', 'loopback by address'],
    ['http://[::1]:3000', 'loopback over IPv6'],
    ['http://0.0.0.0:3000', 'the unspecified address a container binds'],
    ['', 'nothing at all'],
    ['not a url', 'something unparseable'],
  ])('rejects %s (%s)', (value) => {
    expect(publicSiteUrl(value)).toBeNull();
  });

  it.each([
    ['https://example.com?x=1', 'a query string'],
    ['https://user:pass@example.com', 'embedded credentials'],
    ['https://example.com/base/', 'a path'],
  ])('reduces %s to its ORIGIN (%s)', (value) => {
    // The link is built by CONCATENATION, so anything beyond the origin
    // survives into it: `https://example.com?x=1` became
    // `https://example.com?x=1/en/products/<id>`, putting the product path
    // inside the query. Embedded credentials would have gone into a message
    // sent to a seller.
    expect(publicSiteUrl(value)).toBe('https://example.com');
  });

  it.each([
    ['ftp://example.com', 'a non-web scheme'],
    ['javascript:alert(1)', 'a script url'],
  ])('rejects %s (%s)', (value) => {
    // Both parse happily. `javascript:alert(1)` yielded
    // `javascript:alert(1)/en/products/<id>` in an outbound message.
    expect(publicSiteUrl(value)).toBeNull();
  });

  it('accepts a real public origin, without a trailing slash', () => {
    expect(publicSiteUrl('https://laxair.shop/')).toBe('https://laxair.shop');
  });
});

describe('the outbound summary without a public site url', () => {
  it('OMITS the link rather than sending a dead one', () => {
    // A seller who clicks a localhost link concludes the marketplace is
    // broken. One who gets a name, a number and a product does not need the
    // link at all -- which is why this degrades rather than refusing.
    const summary = buildInquirySummary({
      productName: 'Portable Digital X-Ray Machine',
      productId: 'seed-product-01',
      buyerName: 'Asha Rao',
      buyerPhone: '+919000000001',
      siteUrl: 'http://localhost:3000',
    });

    expect(summary).not.toContain('localhost');
    expect(summary).not.toContain('Link:');
    // Everything that makes the inquiry actionable survives.
    expect(summary).toContain('Asha Rao');
    expect(summary).toContain('+919000000001');
    // And it stays traceable without the link.
    expect(summary).toContain('Ref: seed-product-01');
  });

  it('includes the link when a real origin is configured', () => {
    expect(
      buildInquirySummary({
        productName: 'X',
        productId: 'p1',
        buyerName: 'Asha',
        buyerPhone: '+919000000001',
        siteUrl: 'https://laxair.shop',
      }),
    ).toContain('Link: https://laxair.shop/en/products/p1');
  });
});

describe('InquiriesService', () => {
  let service: InquiriesService;
  let prisma: {
    $transaction: jest.Mock;
    product: { findUnique: jest.Mock };
    inquiry: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
  };
  let whatsapp: { sendInquiry: jest.Mock };

  beforeEach(() => {
    prisma = {
      // $transaction hands the callback a client; the mock passes the same
      // object back so assertions on prisma.inquiry.* still see every call
      // the service makes inside the transaction.
      $transaction: jest
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) =>
          Promise.resolve(fn(prisma)),
        ),
      product: { findUnique: jest.fn().mockResolvedValue(PRODUCT) },
      inquiry: {
        // Not seen before: the idempotency lookup must find nothing.
        findUnique: jest.fn().mockResolvedValue(null),
        // Echoes the written data back, as Prisma does -- a bare { id } mock
        // hid the status the service actually returns.
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ id: 'inq-1', ...data }),
          ),
        // Returns the WHOLE row with the change applied, as Prisma does. A
        // mock echoing only `data` back is not a row the code could ever have
        // written, and it made a partial update -- one that changes
        // failureReason without touching status -- look as though it had
        // erased the status.
        update: jest.fn().mockImplementation(({ data }: { data: unknown }) =>
          Promise.resolve({
            ...storedRowFor('inq-1'),
            ...(data as object),
          }),
        ),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    whatsapp = {
      sendInquiry: jest
        .fn()
        .mockResolvedValue({ ok: true, providerMessageId: 'wamid.1' }),
    };
    service = new InquiriesService(
      prisma as unknown as PrismaService,
      whatsapp as unknown as WhatsappService,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  // Captured and RESTORED, not unconditionally deleted. Jest shares a worker
  // process across suites, so deleting a variable this suite did not set
  // leaves later suites running in an environment it changed -- and the
  // resulting failure shows up in whichever file happens to run next.
  const originalIpHashSecret = process.env.INQUIRY_IP_HASH_SECRET;

  afterEach(() => {
    if (originalIpHashSecret === undefined) {
      delete process.env.INQUIRY_IP_HASH_SECRET;
    } else {
      process.env.INQUIRY_IP_HASH_SECRET = originalIpHashSecret;
    }
    jest.restoreAllMocks();
  });

  it('canonicalises a spaced number to E.164 before storing it', async () => {
    // The form advertises "+91 98765 43210" because that is how people write
    // numbers, and IsPhoneNumber accepts it -- but the sender rejects any
    // space, so the inquiry was stored and then failed at send time, which a
    // buyer only discovers by never getting a reply.
    await service.create({ ...ARGS, buyerPhone: '+91 98765 43210' });

    const written = prisma.inquiry.create.mock.calls[0][0] as {
      data: { buyerPhone: string };
    };
    expect(written.data.buyerPhone).toBe('+919876543210');
  });

  it('applies the 2-character minimum to the TRIMMED name', async () => {
    // @Length(2) runs against the untrimmed value, so " A " passed the DTO
    // and was stored as "A".
    await expect(
      service.create({ ...ARGS, buyerName: ' A ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('rejects a number that cannot be made valid', async () => {
    await expect(
      service.create({ ...ARGS, buyerPhone: 'not-a-number' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('rate-limits on the CANONICAL number, not the typed one', async () => {
    // Otherwise the same number written three ways is three buckets, and the
    // per-phone limit is trivially sidestepped with spaces.
    await service.create({ ...ARGS, buyerPhone: '+91 98765 43210' });

    const buckets = prisma.inquiry.count.mock.calls
      .map(
        (call) =>
          (call[0] as { where: { buyerPhone?: string } }).where.buyerPhone,
      )
      .filter(Boolean);
    expect(buckets.every((b) => b === '+919876543210')).toBe(true);
  });

  it('reads the product THROUGH THE TRANSACTION CLIENT, not the base client', async () => {
    // Reading it outside and reusing the copy meant a product reassigned in
    // the gap would have its inquiry attributed to the previous seller --
    // and once delivery exists, that is the buyer's name, phone and question
    // handed to an organisation with nothing to do with the listing. Nothing
    // reassigns products today, which is exactly why it would have gone
    // unnoticed.
    //
    // The transaction client here is a DISTINCT object from the base client.
    // An earlier version of this test handed the callback `prisma` itself, so
    // tx.product and this.prisma.product were the same mock and the assertion
    // could not tell the two apart -- it passed against the very bug it was
    // written to catch.
    const tx = {
      product: { findUnique: jest.fn().mockResolvedValue(PRODUCT) },
      inquiry: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ id: 'inq-1', ...data }),
          ),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction.mockImplementation((fn: (client: unknown) => unknown) =>
      Promise.resolve(fn(tx)),
    );

    await service.create(ARGS);

    // The AUTHORITATIVE read -- the one whose seller the row is attributed
    // to -- goes through the transaction client.
    expect(tx.product.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ include: { seller: true } }),
    );
    expect(tx.inquiry.create).toHaveBeenCalled();

    // The base client is used ONLY for the pre-flight existence check, which
    // selects an id and nothing else. Asserted on its arguments rather than
    // on it never being called: it is called now, and a bare
    // not.toHaveBeenCalled() would have to be deleted to make this pass --
    // taking the original protection with it.
    expect(prisma.product.findUnique).toHaveBeenCalledWith({
      where: { id: ARGS.productId },
      select: { id: true },
    });
    expect(prisma.product.findUnique).toHaveBeenCalledTimes(1);
    // The idempotency recheck goes through the transaction client too. Run
    // against the base client it would read outside the snapshot, which is
    // the whole reason it moved inside.
    expect(tx.inquiry.findUnique).toHaveBeenCalled();
  });

  it('records the seller the transaction saw, not a pre-read copy', async () => {
    // The snapshot taken inside the transaction is what the insert uses.
    // Which seller received an inquiry is a historical fact, so it must come
    // from the same read that decided the product exists -- not from a copy
    // taken before the transaction opened, which a reassignment in the gap
    // would already have invalidated.
    prisma.product.findUnique.mockResolvedValue({
      ...PRODUCT,
      sellerId: 'org-current',
      seller: { id: 'org-current', whatsappNumber: '+919999900000' },
    });

    await service.create(ARGS);

    const written = prisma.inquiry.create.mock.calls[0][0] as {
      data: { sellerId: string };
    };
    expect(written.data.sellerId).toBe('org-current');
  });

  it('trims name and message server-side', async () => {
    // The mutation is public, so a direct caller bypasses the form's trim.
    await service.create({ ...ARGS, buyerName: '  Asha  ', message: '  hi  ' });

    const written = prisma.inquiry.create.mock.calls[0][0] as {
      data: { buyerName: string; message: string };
    };
    expect(written.data.buyerName).toBe('Asha');
    expect(written.data.message).toBe('hi');
  });

  it.each([
    ['   ', 'hi', 'whitespace-only name'],
    ['Asha', '   ', 'whitespace-only message'],
  ])('rejects %s / %s (%s)', async (buyerName, message) => {
    // @Length(2) accepts "  " and @MinLength(1) accepts " ", so the seller
    // would receive an inquiry with no discernible sender or question.
    await expect(
      service.create({ ...ARGS, buyerName, message }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  describe('idempotency', () => {
    it('returns the SAME inquiry for a repeated key, without creating another', async () => {
      // A lost response is indistinguishable from a failed one, so a retry
      // is expected rather than exceptional. Without this it creates a second
      // row -- and once delivery exists, a second message to the seller.
      const already = storedRowFor('inq-existing');
      prisma.inquiry.findUnique.mockResolvedValue(already);

      const result = await service.create(ARGS);

      expect(result).toBe(already);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('writes the key, so the unique index can enforce it', async () => {
      // The lookup only avoids a round trip in the common case; the database
      // constraint is what actually stops a concurrent duplicate.
      await service.create(ARGS);

      const written = prisma.inquiry.create.mock.calls[0][0] as {
        data: { idempotencyKey: string };
      };
      expect(written.data.idempotencyKey).toBe(ARGS.idempotencyKey);
    });

    it('RETURNS THE WINNER when a concurrent duplicate loses the race', async () => {
      // Two requests both passed the findUnique before either inserted; this
      // one lost. The winner's row IS the correct response -- an error here
      // would tell a buyer their inquiry failed when it demonstrably
      // succeeded, and invite the retry idempotency exists to make safe.
      //
      // The previous version of this test asserted the rejection as if it
      // were intended, codifying behaviour that directly contradicted the
      // comment sitting next to the code.
      const collision = new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValue(collision);
      const winner = storedRowFor('inq-winner');
      prisma.inquiry.findUnique
        .mockResolvedValueOnce(null) // the initial idempotency lookup
        .mockResolvedValueOnce(winner); // the post-collision fetch

      await expect(service.create(ARGS)).resolves.toBe(winner);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('returns the winner when a RETRY finds the race already settled', async () => {
      // The boundary case the concurrent test above cannot reach, because it
      // starts from zero rows. Two identical requests race, this one is
      // aborted with P2034 and retried -- and by then the winner's row counts
      // against the very limits the retry re-checks. At a limit boundary that
      // rejected an idempotent duplicate with "Too many inquiries" instead of
      // returning the winner, and the P2002 recovery never ran because the
      // insert was never reached.
      const winner = storedRowFor('inq-winner');
      const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
      let attempt = 0;
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(conflict);
        return Promise.resolve(fn(prisma));
      });
      prisma.inquiry.findUnique
        .mockResolvedValueOnce(null) // the pre-flight lookup, before the race
        .mockResolvedValue(winner); // inside the retried transaction
      // Every bucket is at its ceiling, which is what made this fail.
      prisma.inquiry.count.mockResolvedValue(INQUIRY_RATE_LIMIT_PER_PHONE);

      await expect(service.create(ARGS)).resolves.toBe(winner);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('does not spend rate-limit budget on a duplicate', async () => {
      // A repeat of one submission is not a second submission, so it must not
      // count against the caller. Falls out of checking idempotency inside
      // the transaction, and is worth asserting because moving that check
      // back out would silently restore the old behaviour.
      prisma.inquiry.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(storedRowFor('inq-existing'));

      await service.create(ARGS);

      expect(prisma.inquiry.count).not.toHaveBeenCalled();
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('REJECTS a reused key carrying different details', async () => {
      // Reproduced end to end against a real server before this existed:
      // submit a question, lose the response, correct the phone number and
      // reword the question, submit again -- and the API answered with the
      // ORIGINAL row's id while the buyer was told their edited inquiry was
      // recorded. It never was. The correction was gone and nothing anywhere
      // reported a problem.
      prisma.inquiry.findUnique.mockResolvedValue(
        storedRowFor('inq-existing', { message: 'the ORIGINAL question' }),
      );

      await expect(
        service.create({ ...ARGS, message: 'an EDITED question' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('compares against the CANONICAL values, not the typed ones', async () => {
      // The stored phone is normalised and the stored name trimmed, so a
      // genuine retry that types the number with spaces must still match --
      // otherwise every retry of a spaced number looks like an edit.
      prisma.inquiry.findUnique.mockResolvedValue(
        storedRowFor('inq-existing', { buyerPhone: '+919876543210' }),
      );

      await expect(
        service.create({
          ...ARGS,
          buyerName: '  Asha Rao  ',
          buyerPhone: '+91 98765 43210',
        }),
      ).resolves.toMatchObject({ id: 'inq-existing' });
    });

    it('still propagates a collision it cannot resolve', async () => {
      // If the winner cannot be read back, silence would be worse than an
      // error -- the caller would get a success with nothing behind it.
      const collision = new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValue(collision);
      prisma.inquiry.findUnique.mockResolvedValue(null);

      await expect(service.create(ARGS)).rejects.toBe(collision);
    });
  });

  it('rejects an inquiry about a product that does not exist', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.create(ARGS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent product WITHOUT opening a transaction', async () => {
    // An unauthenticated caller spraying random productIds was paying one
    // SERIALIZABLE transaction per request. It still costs a lookup -- only a
    // request-level control at the edge fixes that, see #152 -- but the
    // cheapest attack no longer buys the most expensive path.
    prisma.product.findUnique.mockResolvedValue(null);

    await expect(service.create(ARGS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inquiry.count).not.toHaveBeenCalled();
  });

  it('denormalizes the seller so a later product reassignment cannot rewrite history', async () => {
    await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sellerId: 'org-1' }),
      }),
    );
  });

  it('never puts the seller number on the buyer path', async () => {
    // The seller's number is on the product row this service reads, and the
    // row it returns is what the resolver shapes a response from. A field
    // carrying it here would reach an anonymous caller (#91 story 6).
    const result = await service.create(ARGS);
    expect(JSON.stringify(result)).not.toContain('+919876543210');
  });

  describe('delivery', () => {
    it('records the inquiry BEFORE attempting delivery', async () => {
      // #91 story 9. A send that fails -- bad credentials, a Meta outage, a
      // number Meta rejects -- must still leave a lead the marketplace can
      // see and retry. Sending first and persisting after loses the lead
      // exactly when something is already wrong.
      const order: string[] = [];
      prisma.inquiry.create.mockImplementation(({ data }: { data: object }) => {
        order.push('create');
        return Promise.resolve({ id: 'inq-1', ...data });
      });
      whatsapp.sendInquiry.mockImplementation(() => {
        order.push('send');
        return Promise.resolve({ ok: true, providerMessageId: 'wamid.1' });
      });

      await service.create(ARGS);

      expect(order).toEqual(['create', 'send']);
    });

    it('marks a delivered inquiry SENT and keeps the provider message id', async () => {
      whatsapp.sendInquiry.mockResolvedValue({
        ok: true,
        providerMessageId: 'wamid.abc',
      });

      const result = await service.create(ARGS);

      expect(result.status).toBe(InquiryStatus.SENT);
      expect(result.providerMessageId).toBe('wamid.abc');
    });

    it('sends to the seller the TRANSACTION saw, not a later re-read', async () => {
      // The product snapshot travels with the row. Looking the number up
      // again after the transaction closed would reopen the reassignment gap
      // -- and once delivery exists, that gap hands a buyer's name and phone
      // number to an organisation with nothing to do with the listing.
      prisma.product.findUnique.mockResolvedValue({
        ...PRODUCT,
        sellerId: 'org-current',
        seller: { id: 'org-current', whatsappNumber: '+919999900000' },
      });

      await service.create(ARGS);

      expect(whatsapp.sendInquiry).toHaveBeenCalledWith(
        '+919999900000',
        expect.anything(),
      );
    });

    it('still records the lead when the provider rejects the send', async () => {
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        reason: 'provider 400: invalid recipient',
      });

      const result = await service.create(ARGS);

      expect(result.status).toBe(InquiryStatus.FAILED);
      expect(prisma.inquiry.create).toHaveBeenCalled();
    });

    it('still records the lead when the seller has no number', async () => {
      // A configuration state, not a buyer error. The form is hidden for such
      // sellers, so reaching this means a direct caller or a number removed
      // after the page loaded -- and the lead is deliverable once they are
      // onboarded.
      prisma.product.findUnique.mockResolvedValue({
        ...PRODUCT,
        seller: { id: 'org-1', whatsappNumber: null },
      });

      const result = await service.create(ARGS);

      expect(result.status).toBe(InquiryStatus.FAILED);
      expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
      expect(prisma.inquiry.create).toHaveBeenCalled();
    });

    it('leaves an AMBIGUOUS outcome PENDING, never FAILED', async () => {
      // A timeout or a dropped connection means the request may have reached
      // Meta and been accepted before the response was lost. FAILED invites a
      // retry that double-messages the seller; PENDING says what is true --
      // we do not know.
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        ambiguous: true,
        reason: 'provider timed out after 10000ms',
      });

      const result = await service.create(ARGS);

      expect(result.status).toBe(InquiryStatus.PENDING);
      // The ATTEMPT is recorded even though the status is not changed. It
      // previously wrote nothing, so a row left PENDING by an ambiguous send
      // was byte-identical to one left PENDING by a crash before the send --
      // and the recovery sweep those are parked for could not tell them
      // apart. providerMessageId cannot distinguish them either, because an
      // ambiguous send never returns one.
      const written = prisma.inquiry.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(written.data)).toEqual(['failureReason']);
      expect(written.data.failureReason).toMatch(/timed out/);
      expect(result.failureReason).toMatch(/timed out/);
    });

    it('leaves a never-attempted row distinguishable from an ambiguous one', async () => {
      // The whole point of recording the attempt: a sweeper keys off this.
      whatsapp.sendInquiry.mockResolvedValue({
        ok: true,
        providerMessageId: 'wamid.1',
      });

      const delivered = await service.create(ARGS);

      // A delivered row carries an id and no reason; an ambiguous one carries
      // a reason and no id; a never-attempted row carries neither.
      expect(delivered.providerMessageId).toBe('wamid.1');
      expect(delivered.failureReason ?? null).toBeNull();
    });

    it('does NOT deliver again for an idempotent retry', async () => {
      // The whole mechanism defeated through the back door: the database
      // deduplicates perfectly and the seller is messaged twice anyway.
      // Delivery is gated on this call having actually written the row.
      prisma.inquiry.findUnique.mockResolvedValue(storedRowFor('inq-existing'));

      await service.create(ARGS);

      expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
    });

    it('is never failed by an unexpected throw from the provider layer', async () => {
      // sendInquiry returns a result rather than throwing, but that is a
      // property of its code today -- it builds its request payload before
      // its own try. The lead is already saved by the time delivery runs, so
      // an escape would tell the buyer their inquiry failed when it is
      // sitting in the table, and invite them to submit it again.
      whatsapp.sendInquiry.mockImplementation(() => {
        throw new TypeError('payload build blew up');
      });

      const result = await service.create(ARGS);

      expect(result.id).toBe('inq-1');
      expect(prisma.inquiry.create).toHaveBeenCalled();
    });

    it('flattens provider text before STORING it, not just before logging', async () => {
      // failureReason is on a column an operator reads and may paste
      // elsewhere; newlines in it are the same hazard one step removed.
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        reason: 'provider said\nERROR forged\tline',
      });

      await service.create(ARGS);

      const written = prisma.inquiry.update.mock.calls[0][0] as {
        data: { failureReason: string };
      };
      expect(written.data.failureReason).not.toContain('\n');
      expect(written.data.failureReason).not.toContain('\t');
    });

    it('does not report failure when marking a FAILED inquiry fails', async () => {
      // The inquiry is already persisted, so a transient write error must not
      // escape and tell the buyer their submission failed -- inviting them to
      // resubmit something that was recorded.
      whatsapp.sendInquiry.mockResolvedValue({ ok: false, reason: 'nope' });
      prisma.inquiry.update.mockRejectedValue(new Error('db down'));

      const result = await service.create(ARGS);

      expect(result.status).toBe(InquiryStatus.FAILED);
    });

    it('still reports a DELIVERED inquiry as SENT when marking it fails', async () => {
      // Meta ACCEPTED this message. Returning the untouched PENDING row made
      // the resolver report delivered:false and show the buyer "we could not
      // reach the seller" for a message that had in fact arrived.
      whatsapp.sendInquiry.mockResolvedValue({
        ok: true,
        providerMessageId: 'wamid.xyz',
      });
      prisma.inquiry.update.mockRejectedValue(new Error('db down'));

      const result = await service.create(ARGS);

      expect(result.status).toBe(InquiryStatus.SENT);
      expect(result.providerMessageId).toBe('wamid.xyz');
    });

    it('truncates a runaway provider failure reason', async () => {
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        reason: 'x'.repeat(5000),
      });

      await service.create(ARGS);

      const written = prisma.inquiry.update.mock.calls[0][0] as {
        data: { failureReason: string };
      };
      expect(written.data.failureReason.length).toBeLessThanOrEqual(500);
    });

    it('never lets raw provider text reach the logger', async () => {
      // Meta's error.message is external input. Newlines let it forge log
      // entries that look like ours, and the column truncation happens after
      // the log call, so it protects the wrong thing.
      const warn = jest.spyOn(service['logger'], 'warn');
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        reason: 'line one\nERROR forged line two\ttabbed',
      });

      await service.create(ARGS);

      const logged = warn.mock.calls.map((c) => String(c[0])).join(' ');
      expect(logged).not.toContain('\n');
      expect(logged).not.toContain('\t');
    });
  });

  describe('rate limiting', () => {
    it('rejects once the per-phone limit is reached', async () => {
      prisma.inquiry.count
        .mockResolvedValueOnce(INQUIRY_RATE_LIMIT_PER_PHONE)
        .mockResolvedValueOnce(0);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('rejects once the per-phone-per-product limit is reached', async () => {
      // Stops one buyer pestering one seller about one item, which the
      // broader per-phone limit alone would allow up to its ceiling.
      prisma.inquiry.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('counts from the database, not an in-process counter', async () => {
      // An in-memory counter resets on deploy and is per-instance, so it
      // would be defeated by a restart or by horizontal scaling.
      await service.create(ARGS);
      // Three when no address resolved: per-phone, per-phone-product and the
      // per-seller cap. The IP bucket is deliberately skipped rather than
      // counted as null -- collapsing every unresolvable caller into one
      // shared bucket would let a single one lock out all the others.
      expect(prisma.inquiry.count).toHaveBeenCalledTimes(3);
    });

    it('adds an IP bucket when the address resolves AND a secret exists', async () => {
      // The dimension the caller cannot type. Without it, rotating E.164
      // numbers defeats every other limit here. Requires a hash secret --
      // see the storage test below for why there is no unkeyed fallback.
      process.env.INQUIRY_IP_HASH_SECRET = TEST_IP_HASH_SECRET;
      await service.create({ ...ARGS, callerIp: '203.0.113.7' });

      expect(prisma.inquiry.count).toHaveBeenCalledTimes(4);
      const buckets = prisma.inquiry.count.mock.calls.map((call) =>
        Object.keys((call[0] as { where: object }).where)
          .sort()
          .join(','),
      );
      expect(buckets).toContain('createdAt,ipHash');
    });

    it('stores the address hashed, never in the clear', async () => {
      // A raw IP is personal data under DPDP sitting in a table operators
      // read to triage leads. A hash still counts repeats.
      process.env.INQUIRY_IP_HASH_SECRET = TEST_IP_HASH_SECRET;
      await service.create({ ...ARGS, callerIp: '203.0.113.7' });

      const written = prisma.inquiry.create.mock.calls[0][0] as {
        data: { ipHash: string };
      };
      expect(written.data.ipHash).not.toContain('203.0.113.7');
      expect(written.data.ipHash).toMatch(/[0-9a-f]{64}$/);
    });

    it('keys the hash with the configured secret', () => {
      const keyed = hashIp('203.0.113.7', {
        INQUIRY_IP_HASH_SECRET: TEST_IP_HASH_SECRET,
      });

      expect(keyed).toMatch(/^[0-9a-f]{64}$/);
      // Deterministic, or it could not group repeats.
      expect(
        hashIp('203.0.113.7', {
          INQUIRY_IP_HASH_SECRET: TEST_IP_HASH_SECRET,
        }),
      ).toBe(keyed);
    });

    it('STORES NOTHING when there is no usable secret', () => {
      // An unkeyed SHA-256 of an IPv4 address is reversible by anyone holding
      // the table -- 2^32 is small enough to enumerate outright. An earlier
      // version stored one prefixed "unkeyed:", which labelled the weakness
      // without removing it: the personal data was still recoverable.
      // Declining to store anything is the only honest option, and the
      // limiter already skips a null bucket, so the per-IP limit simply does
      // not run rather than running on a reversible digest.
      expect(hashIp('203.0.113.7', {})).toBeNull();
      // A short secret is guessable, which puts us back where we started.
      expect(
        hashIp('203.0.113.7', { INQUIRY_IP_HASH_SECRET: 'short' }),
      ).toBeNull();
    });

    it('rejects once the per-IP limit is reached', async () => {
      // Asserted directly, not merely that the count happens -- the review
      // pointed out the old test proved the query ran and nothing more.
      process.env.INQUIRY_IP_HASH_SECRET = TEST_IP_HASH_SECRET;
      prisma.inquiry.count.mockImplementation(
        ({ where }: { where: { ipHash?: string } }) =>
          Promise.resolve(where.ipHash ? INQUIRY_RATE_LIMIT_PER_IP : 0),
      );

      await expect(
        service.create({ ...ARGS, callerIp: '203.0.113.7' }),
      ).rejects.toThrow(/from this network/);
    });

    it("caps a seller's total exposure whatever the source", async () => {
      // The only limit still standing when an attacker rotates BOTH phone
      // numbers and addresses, so it is what actually bounds the spam a
      // seller can be made to receive.
      prisma.inquiry.count.mockImplementation(
        ({ where }: { where: { sellerId?: string } }) =>
          Promise.resolve(where.sellerId ? INQUIRY_RATE_LIMIT_PER_SELLER : 0),
      );

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('does not tell the caller which seller cap they hit', async () => {
      // Naming it hands an attacker a progress indicator for the one limit
      // they cannot rotate around.
      prisma.inquiry.count.mockImplementation(
        ({ where }: { where: { sellerId?: string } }) =>
          Promise.resolve(where.sellerId ? INQUIRY_RATE_LIMIT_PER_SELLER : 0),
      );

      await expect(service.create(ARGS)).rejects.toThrow(
        /Too many inquiries right now/,
      );
    });

    it('retries a serialization conflict instead of surfacing a 500', async () => {
      // Serializable isolation does not queue conflicting transactions, it
      // ABORTS one -- Prisma reports P2034. Without a retry, two buyers
      // submitting at the same instant meant one received an internal error
      // rather than succeeding or being told about the rate limit.
      const conflict = new Prisma.PrismaClientKnownRequestError(
        'write conflict',
        { code: 'P2034', clientVersion: 'test' },
      );
      let attempts = 0;
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(conflict);
        return Promise.resolve(fn(prisma));
      });

      await expect(service.create(ARGS)).resolves.toBeDefined();
      expect(attempts).toBe(2);
    });

    it('does NOT retry a rate-limit rejection', async () => {
      // Retrying a deliberate refusal would turn one rejection into three.
      let attempts = 0;
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        attempts += 1;
        return Promise.resolve(fn(prisma));
      });
      prisma.inquiry.count.mockResolvedValue(INQUIRY_RATE_LIMIT_PER_PHONE);

      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(attempts).toBe(1);
    });

    it('gives up after a bounded number of conflicts', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValue(conflict);

      await expect(service.create(ARGS)).rejects.toBe(conflict);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('runs the check and the insert in one serializable transaction', async () => {
      // Counting and then inserting separately is a time-of-check/
      // time-of-use race: concurrent callers all read a count below the
      // threshold and all proceed.
      await service.create(ARGS);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const options = prisma.$transaction.mock.calls[0][1] as {
        isolationLevel: string;
      };
      expect(options.isolationLevel).toBe('Serializable');
    });

    it('checks the limit before writing anything', async () => {
      prisma.inquiry.count.mockResolvedValue(INQUIRY_RATE_LIMIT_PER_PHONE);
      await expect(service.create(ARGS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });
  });
});

describe('assertSameSubmission', () => {
  const identity = {
    productId: 'seed-product-01',
    buyerName: 'Asha Rao',
    buyerPhone: '+919000000001',
    message: 'Is this available in Chennai?',
  };
  const stored = { id: 'inq-1', ...identity };

  it('returns the row when every field matches', () => {
    expect(assertSameSubmission(stored, identity)).toBe(stored);
  });

  it.each(['productId', 'buyerName', 'buyerPhone', 'message'] as const)(
    'rejects when %s differs',
    (field) => {
      // Every field, not just the message. An edited phone number is the one
      // that costs the buyer a reply they can never receive, and a changed
      // productId would attribute one seller's lead to another.
      expect(() =>
        assertSameSubmission(stored, {
          ...identity,
          [field]: 'something else',
        }),
      ).toThrow(BadRequestException);
    },
  );

  it('ignores fields that are not part of the submission', () => {
    // The comparison walks a fixed list, not the argument's own keys.
    // Deriving it from the caller made the check depend on what that caller
    // passed: insertInquiry hands over the full insert args, so ipHash
    // joined in and a genuine retry from a different address was rejected as
    // an edit. Caught by an existing test, not by review.
    expect(
      assertSameSubmission({ ...stored, ipHash: 'aaa' }, {
        ...identity,
        ipHash: 'bbb',
      } as never),
    ).toMatchObject({ id: 'inq-1' });
  });

  it('rejects with a message the client does not read as a rate limit', () => {
    // categorizeInquiryError maps "already sent inquiries" to the rate-limit
    // category, and the first wording here was "already sent with different
    // details" -- so a key conflict told the buyer to wait, which cannot
    // help. These strings are a wire contract between the two apps, not
    // prose.
    try {
      assertSameSubmission(stored, { ...identity, message: 'different' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('already sent');
      expect((error as Error).message).toContain('already used');
    }
  });

  it('never echoes what the key currently holds', () => {
    // The key is caller-chosen, so a message naming the stored values would
    // let anyone read back someone else's inquiry by guessing keys.
    try {
      assertSameSubmission(stored, { ...identity, message: 'different' });
      throw new Error('expected a rejection');
    } catch (error) {
      const text = (error as Error).message;
      for (const secret of Object.values(identity)) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
