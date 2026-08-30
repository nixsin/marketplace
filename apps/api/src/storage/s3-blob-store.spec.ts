// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { S3BlobStore } from './s3-blob-store';

/**
 * The production storage path, which had no test at all.
 *
 * It is also the one adapter whose correctness cannot be observed locally:
 * LocalBlobStore is exercised by its own suite against a real temp
 * directory, while this class only ever runs against a remote provider. So
 * the properties worth pinning are the ones that would fail silently in
 * production -- a "missing object" reported as a hard error, a key that
 * escapes its prefix, or a signed endpoint URL handed out as a public one.
 *
 * The S3Client is replaced on the instance rather than mocked at module
 * level: this suite uses no `jest.mock`, deliberately, because it has no
 * direct ESM equivalent (see CLAUDE.md). `private` is a compile-time
 * construct, so the field is writable at runtime, and swapping it keeps
 * the real constructor -- including the forcePathStyle derivation below --
 * genuinely under test.
 */
describe('S3BlobStore', () => {
  const options = {
    bucket: 'test-bucket',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    region: 'auto',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    toPublicUrl: (key: string) => `https://images.example.com/${key}`,
  };

  let send: jest.Mock;
  let store: S3BlobStore;

  function makeStore(overrides: Partial<typeof options> = {}) {
    const s = new S3BlobStore({ ...options, ...overrides });
    send = jest.fn();
    (s as unknown as { client: { send: unknown } }).client = { send };
    return s;
  }

  /** The command name and input of the single call that was made. */
  function sentCommand() {
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    return { name: command.constructor.name, input: command.input };
  }

  beforeEach(() => {
    store = makeStore();
  });

  describe('addressing', () => {
    it('uses PATH style when a custom endpoint is supplied', () => {
      // R2, MinIO and friends put the bucket in the path; S3 uses a
      // subdomain. Derived from whether an endpoint was given, so no
      // provider is ever named in this file -- the moment one is, the
      // portability claim in its doc comment stops being true.
      const s = new S3BlobStore(options);
      const config = (
        s as unknown as { client: { config: Record<string, unknown> } }
      ).client.config;

      expect(config.forcePathStyle).toBe(true);
    });

    it('uses SUBDOMAIN style when no endpoint is supplied (AWS)', () => {
      const s = new S3BlobStore({ ...options, endpoint: undefined });
      const config = (
        s as unknown as { client: { config: Record<string, unknown> } }
      ).client.config;

      expect(config.forcePathStyle).toBe(false);
    });
  });

  describe('put', () => {
    it('sends the body and content type to the configured bucket', async () => {
      send.mockResolvedValue({});

      const body = Buffer.from('bytes');

      await store.put('products/a.png', body, 'image/png');

      const { name, input } = sentCommand();
      expect(name).toBe('PutObjectCommand');
      expect(input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'products/a.png',
        ContentType: 'image/png',
      });
      // The bytes themselves, not just the metadata around them -- dropping
      // or replacing the payload would otherwise pass this test.
      expect(input.Body).toBe(body);
    });

    it('rejects a traversing key BEFORE any request is made', async () => {
      // The check has to run first: a key that escapes its prefix must
      // never reach the provider, where it would write outside the
      // namespace this app believes it owns.
      await expect(
        store.put('../secrets/a.png', Buffer.from('x'), 'image/png'),
      ).rejects.toThrow();

      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns the object body as a Buffer', async () => {
      send.mockResolvedValue({
        Body: {
          transformToByteArray: () =>
            Promise.resolve(new Uint8Array([1, 2, 3])),
        },
      });

      await expect(store.get('products/a.png')).resolves.toEqual(
        Buffer.from([1, 2, 3]),
      );
    });

    it('reads from the right bucket and key', async () => {
      // Behaviour alone proves nothing about WHICH object was read -- the
      // stub returns the same bytes for any Bucket/Key.
      send.mockResolvedValue({
        Body: {
          transformToByteArray: () =>
            Promise.resolve(new Uint8Array([1, 2, 3])),
        },
      });

      await store.get('products/a.png');

      const { name, input } = sentCommand();
      expect(name).toBe('GetObjectCommand');
      expect(input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'products/a.png',
      });
    });

    it('rejects a traversing key BEFORE any request is made', async () => {
      // The read paths take caller-supplied keys too; a key that escapes
      // the prefix must not reach the provider on the way out either.
      await expect(store.get('../secrets/a.png')).rejects.toThrow();

      expect(send).not.toHaveBeenCalled();
    });

    it('returns null for a response with no body', async () => {
      send.mockResolvedValue({});

      await expect(store.get('products/a.png')).resolves.toBeNull();
    });

    it.each([
      ['NoSuchKey by name (what S3 returns for GET)', { name: 'NoSuchKey' }],
      ['NotFound by name (what other providers return)', { name: 'NotFound' }],
      [
        'a bare 404 with no code at all',
        { $metadata: { httpStatusCode: 404 } },
      ],
    ])('returns null for %s', async (_label, error) => {
      // All three spellings, because providers disagree. Matching only on
      // `name` works against S3 and then reports every missing object as a
      // hard error somewhere else -- exactly the silent portability
      // regression this adapter exists to avoid.
      send.mockRejectedValue(error);

      await expect(store.get('products/a.png')).resolves.toBeNull();
    });

    it('RETHROWS a real failure rather than reporting "missing"', async () => {
      // A 500 or a credentials error must not be laundered into "no such
      // object" -- that turns an outage into silently missing images.
      send.mockRejectedValue({
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });

      await expect(store.get('products/a.png')).rejects.toMatchObject({
        name: 'AccessDenied',
      });
    });
  });

  describe('exists', () => {
    it('is true when the object is there', async () => {
      send.mockResolvedValue({});

      await expect(store.exists('products/a.png')).resolves.toBe(true);
      expect(sentCommand().name).toBe('HeadObjectCommand');
    });

    it('asks about the right bucket and key', async () => {
      send.mockResolvedValue({});

      await store.exists('products/a.png');

      const { input } = sentCommand();
      expect(input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'products/a.png',
      });
    });

    it('rejects a traversing key before asking the provider anything', async () => {
      await expect(store.exists('../secrets/a.png')).rejects.toThrow();

      expect(send).not.toHaveBeenCalled();
    });

    it('is false when the provider says not found', async () => {
      send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });

      await expect(store.exists('products/a.png')).resolves.toBe(false);
    });

    it('RETHROWS a real failure rather than answering false', async () => {
      send.mockRejectedValue({ name: 'AccessDenied' });

      await expect(store.exists('products/a.png')).rejects.toMatchObject({
        name: 'AccessDenied',
      });
    });
  });

  describe('delete', () => {
    it('sends a delete for the key', async () => {
      send.mockResolvedValue({});

      await store.delete('products/a.png');

      const { name, input } = sentCommand();
      expect(name).toBe('DeleteObjectCommand');
      expect(input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'products/a.png',
      });
    });

    it('rejects a traversing key before deleting anything', async () => {
      await expect(store.delete('../a.png')).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('publicUrl', () => {
    it('returns the CDN url, NOT the S3 endpoint', () => {
      // The S3 endpoint needs signed requests, and signing every image URL
      // makes it uncacheable and expiring -- wrong for a public catalogue.
      expect(store.publicUrl('products/a.png')).toBe(
        'https://images.example.com/products/a.png',
      );
      expect(store.publicUrl('products/a.png')).not.toContain(
        'r2.cloudflarestorage.com',
      );
    });

    it('validates the key here too', () => {
      expect(() => store.publicUrl('../a.png')).toThrow();
    });
  });
});
