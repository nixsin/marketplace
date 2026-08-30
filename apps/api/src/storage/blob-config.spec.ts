import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOB_CREDENTIAL_ENV,
  BLOB_PROVIDERS,
  blobEndpoint,
  blobUrl,
  resolveBlobCredentials,
} from './blob-config';

describe('blobUrl', () => {
  it('falls back to a root-relative path when no base URL is set', () => {
    // What keeps the currently-committed images working unchanged: this
    // feature lands with zero behaviour change until a provider is set.
    expect(blobUrl('products/x.png', '')).toBe('/products/x.png');
    expect(blobUrl('/products/x.png', '')).toBe('/products/x.png');
  });

  it('joins against a configured base without doubling slashes', () => {
    expect(blobUrl('products/x.png', 'https://images.laxair.shop')).toBe(
      'https://images.laxair.shop/products/x.png',
    );
    expect(blobUrl('/products/x.png', 'https://images.laxair.shop/')).toBe(
      'https://images.laxair.shop/products/x.png',
    );
  });
});

describe('blobEndpoint', () => {
  it('resolves every S3-compatible provider from config alone', () => {
    // The portability claim, asserted rather than described: switching
    // provider is a config change, and none of these needs new code.
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      [
        { BLOB_PROVIDER: 'r2', BLOB_ACCOUNT: 'acc123' },
        'https://acc123.r2.cloudflarestorage.com',
      ],
      [
        { BLOB_PROVIDER: 'b2', BLOB_REGION: 'us-west-004' },
        'https://s3.us-west-004.backblazeb2.com',
      ],
      [
        { BLOB_PROVIDER: 'spaces', BLOB_REGION: 'blr1' },
        'https://blr1.digitaloceanspaces.com',
      ],
      [{ BLOB_PROVIDER: 's3', BLOB_REGION: 'ap-south-1' }, ''],
    ];
    for (const [env, expected] of cases) {
      expect(blobEndpoint(env)).toBe(expected);
    }
  });

  it('lets an explicit endpoint override the template', () => {
    // Required for MinIO and any self-hosted or proxied deployment.
    expect(
      blobEndpoint({
        BLOB_PROVIDER: 'r2',
        BLOB_ENDPOINT: 'http://localhost:9000',
      }),
    ).toBe('http://localhost:9000');
  });

  it('treats every provider except local as S3-compatible', () => {
    for (const [name, provider] of Object.entries(BLOB_PROVIDERS)) {
      expect(provider.s3Compatible).toBe(name !== 'local');
    }
  });
});

describe('resolveBlobCredentials', () => {
  it('reads by name at call time', () => {
    expect(
      resolveBlobCredentials({
        BLOB_ACCESS_KEY_ID: 'id-1',
        BLOB_SECRET_ACCESS_KEY: 'secret-1',
      }),
    ).toEqual({ accessKeyId: 'id-1', secretAccessKey: 'secret-1' });
  });

  it('names the missing variable but never the value of the present one', () => {
    // A misconfiguration must not leak a partially-set key into a public
    // CI log.
    expect(() =>
      resolveBlobCredentials({
        BLOB_ACCESS_KEY_ID: 'id-1',
        BLOB_PROVIDER: 'r2',
      }),
    ).toThrow(/BLOB_SECRET_ACCESS_KEY/);

    try {
      resolveBlobCredentials({ BLOB_ACCESS_KEY_ID: 'id-1' });
    } catch (error) {
      expect((error as Error).message).not.toContain('id-1');
    }
  });

  it('carries env var NAMES, never values', () => {
    expect(BLOB_CREDENTIAL_ENV.accessKeyId).toBe('BLOB_ACCESS_KEY_ID');
  });
});

describe('the migration script mirrors this provider table', () => {
  // upload-blobs.mjs is a standalone tool that reads env directly rather
  // than importing this file, so it carries its own copy of the table.
  // Duplication without a guard is exactly how the two silently drift --
  // a provider added here and forgotten there would fail only when
  // someone actually ran the migration, with a confusing endpoint error.
  const script = readFileSync(
    join(import.meta.dirname, '..', '..', 'scripts', 'upload-blobs.mjs'),
    'utf8',
  );

  it.each(Object.keys(BLOB_PROVIDERS))('knows about %s', (name) => {
    expect(script).toContain(`${name}: {`);
  });

  it('uses the same endpoint templates', () => {
    for (const provider of Object.values(BLOB_PROVIDERS)) {
      if (provider.endpoint) expect(script).toContain(provider.endpoint);
    }
  });
});
