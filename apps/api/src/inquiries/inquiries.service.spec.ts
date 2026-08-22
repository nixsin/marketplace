import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH,
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
} from '@medinstru/config';
import {
  InquiriesService,
  sanitizeForLog,
  buildInquiryMessage,
  buildInquirySummary,
  hashIp,
} from './inquiries.service';
import { sanitizeTemplateParam } from './whatsapp.service';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';

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
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve({ id: 'inq-1', ...(data as object) }),
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

  afterEach(() => {
    delete process.env.INQUIRY_IP_HASH_SECRET;
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
    // the gap would have its inquiry attributed to, and DELIVERED TO, the
    // previous seller -- handing the buyer's name, phone and question to an
    // organisation with nothing to do with the listing. Nothing reassigns
    // products today, which is exactly why it would have gone unnoticed.
    //
    // The transaction client here is a DISTINCT object from the base client.
    // An earlier version of this test handed the callback `prisma` itself, so
    // tx.product and this.prisma.product were the same mock and the assertion
    // could not tell the two apart -- it passed against the very bug it was
    // written to catch.
    const tx = {
      product: { findUnique: jest.fn().mockResolvedValue(PRODUCT) },
      inquiry: {
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

    expect(tx.product.findUnique).toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(tx.inquiry.create).toHaveBeenCalled();
  });

  it('sends to the seller the transaction saw, not a pre-read copy', async () => {
    // The snapshot taken inside the transaction is what BOTH the insert and
    // the send use.
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

  it('does not report failure when marking a FAILED inquiry fails either', async () => {
    // The SENT path was already defensive; the FAILED path was not, which is
    // a difference with no justification. The inquiry is already persisted by
    // the time either runs, so letting the write error escape tells the buyer
    // their submission failed and invites them to resubmit it.
    whatsapp.sendInquiry.mockResolvedValue({
      ok: false,
      reason: 'provider 400',
    });
    prisma.inquiry.update.mockRejectedValue(new Error('connection lost'));
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    const result = await service.create(ARGS);

    // A usable row, never null -- returning null would push the failure onto
    // the caller, which is the very thing the catch exists to prevent.
    expect(result).toBeDefined();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('does not report failure when the seller has no number and the write fails', async () => {
    prisma.product.findUnique.mockResolvedValue({
      ...PRODUCT,
      seller: { id: 'org-1', whatsappNumber: null },
    });
    prisma.inquiry.update.mockRejectedValue(new Error('connection lost'));
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    await expect(service.create(ARGS)).resolves.toBeDefined();
  });

  it('still reports a DELIVERED inquiry as SENT when marking it fails', async () => {
    // The provider has already accepted the message. Surfacing the write
    // error would tell the buyer it did not go through and invite a retry
    // that sends the seller a duplicate.
    //
    // And the RETURNED status matters, not just that it resolves: the
    // resolver derives `delivered` from it, so returning the untouched
    // PENDING row showed the buyer "we couldn't reach the seller, try another
    // way" for a message that had in fact arrived. The earlier version of
    // this test only asserted it resolved and sailed straight past that.
    prisma.inquiry.update.mockRejectedValue(new Error('connection lost'));
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    const result = await service.create(ARGS);

    expect(result).toMatchObject({
      status: 'SENT',
      providerMessageId: 'wamid.1',
    });
  });

  describe('idempotency', () => {
    it('returns the SAME inquiry for a repeated key, without creating another', async () => {
      // A lost response is indistinguishable from a failed one, so a retry is
      // expected. Without this it creates a second row AND sends the seller a
      // second WhatsApp message.
      const already = { id: 'inq-existing', status: 'SENT' };
      prisma.inquiry.findUnique.mockResolvedValue(already);

      const result = await service.create(ARGS);

      expect(result).toBe(already);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
      expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
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
      const winner = { id: 'inq-winner', status: 'SENT' };
      prisma.inquiry.findUnique
        .mockResolvedValueOnce(null) // the initial idempotency lookup
        .mockResolvedValueOnce(winner); // the post-collision fetch

      await expect(service.create(ARGS)).resolves.toBe(winner);
      expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
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

  describe('ambiguous provider outcomes', () => {
    it('leaves an inquiry PENDING when the send may have gone through', async () => {
      // A timeout is not a failure: Meta may have accepted the request before
      // the response was lost. Marking it FAILED invites a retry that
      // double-messages the seller. PENDING says what is actually true --
      // we do not know.
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        ambiguous: true,
        reason: 'provider timed out after 10000ms',
      });
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.create(ARGS);

      expect(result).toMatchObject({ status: 'PENDING' });
      // Never written as FAILED.
      expect(prisma.inquiry.update).not.toHaveBeenCalled();
    });

    it('still marks a DEFINITE rejection FAILED', async () => {
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        reason: 'provider 400: Invalid recipient',
      });
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      await service.create(ARGS);

      expect(prisma.inquiry.update).toHaveBeenCalled();
    });
  });

  describe('log safety', () => {
    it('flattens and bounds provider text before logging it', () => {
      // Meta's error.message is external input: newlines forge log entries
      // that look like ours, and an unbounded value inflates log volume. The
      // 500-char database truncation happened AFTER the log call.
      const nasty = 'boom\n2026-01-01 FAKE LOG LINE\ttab';
      const safe = sanitizeForLog(nasty);

      expect(safe).not.toMatch(/[\r\n\t]/);
      expect(sanitizeForLog('x'.repeat(5000)).length).toBeLessThanOrEqual(200);
    });

    it('never lets raw provider text reach the logger', async () => {
      whatsapp.sendInquiry.mockResolvedValue({
        ok: false,
        reason: 'line one\nline two',
      });
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);

      await service.create(ARGS);

      for (const call of warn.mock.calls) {
        expect(String(call[0])).not.toMatch(/\n/);
      }
    });
  });

  it('rejects an inquiry about a product that does not exist', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.create(ARGS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('records the inquiry BEFORE attempting delivery', async () => {
    // The whole design. Sending first and persisting after would discard a
    // real buyer on every provider hiccup.
    const order: string[] = [];
    prisma.inquiry.create.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({ id: 'inq-1' });
    });
    whatsapp.sendInquiry.mockImplementation(() => {
      order.push('send');
      return Promise.resolve({ ok: true, providerMessageId: 'wamid.1' });
    });

    await service.create(ARGS);

    expect(order).toEqual(['persist', 'send']);
  });

  it('marks a delivered inquiry SENT and keeps the provider message id', async () => {
    const result = await service.create(ARGS);

    expect(result).toMatchObject({
      status: 'SENT',
      providerMessageId: 'wamid.1',
    });
  });

  it('denormalizes the seller so a later product reassignment cannot rewrite history', async () => {
    await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sellerId: 'org-1' }),
      }),
    );
  });

  it('still records the lead when the provider rejects the send', async () => {
    whatsapp.sendInquiry.mockResolvedValue({
      ok: false,
      reason: 'provider 400',
    });

    const result = await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('still records the lead when the seller has no WhatsApp number', async () => {
    // A seller not yet onboarded is a configuration state, not a buyer error.
    prisma.product.findUnique.mockResolvedValue({
      ...PRODUCT,
      seller: { id: 'org-1', whatsappNumber: null },
    });

    const result = await service.create(ARGS);

    expect(prisma.inquiry.create).toHaveBeenCalled();
    expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('truncates a runaway provider failure reason', async () => {
    whatsapp.sendInquiry.mockResolvedValue({
      ok: false,
      reason: 'x'.repeat(5000),
    });

    const result = (await service.create(ARGS)) as { failureReason: string };

    expect(result.failureReason.length).toBe(500);
  });

  it('never sends the seller number to the buyer path', async () => {
    const result = await service.create(ARGS);
    expect(JSON.stringify(result)).not.toContain('+919876543210');
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
      expect(whatsapp.sendInquiry).not.toHaveBeenCalled();
    });
  });
});
