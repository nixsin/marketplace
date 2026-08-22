import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  INQUIRY_RATE_LIMIT_PER_IP,
  INQUIRY_RATE_LIMIT_PER_SELLER,
  INQUIRY_RATE_LIMIT_PER_PHONE,
  INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT,
} from '@medinstru/config';
import { InquiriesService, hashIp } from './inquiries.service';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
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

const ARGS = {
  idempotencyKey: 'test-submission-key-0001',
  productId: 'seed-product-01',
  buyerName: 'Asha Rao',
  buyerPhone: '+919000000001',
  message: 'Is this available in Chennai?',
};

describe('InquiriesService', () => {
  let service: InquiriesService;
  let prisma: {
    $transaction: jest.Mock;
    product: { findUnique: jest.Mock };
    inquiry: {
      findUnique: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
    };
  };

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
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new InquiriesService(prisma as unknown as PrismaService);
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
      const already = { id: 'inq-existing', status: 'SENT' };
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
      const winner = { id: 'inq-winner', status: 'SENT' };
      prisma.inquiry.findUnique
        .mockResolvedValueOnce(null) // the initial idempotency lookup
        .mockResolvedValueOnce(winner); // the post-collision fetch

      await expect(service.create(ARGS)).resolves.toBe(winner);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
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
