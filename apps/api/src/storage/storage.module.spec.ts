import { createBlobStore } from './storage.module';
import { LocalBlobStore } from './local-blob-store';
import { S3BlobStore } from './s3-blob-store';
import { BLOB_CREDENTIAL_ENV } from './blob-config';

/**
 * The factory that decides which storage backend production actually uses.
 *
 * It had no test, and the reason is worth recording: it lives in a file
 * named `*.module.ts`, and every conventional coverage config excludes
 * that pattern as decorator-only boilerplate. Here it is not -- the file
 * holds a real exported function with three branches, and the wrong one
 * silently writes uploads to a local directory that no CDN serves.
 *
 * These tests were what the "audit every excluded path" pass turned up;
 * the exclusion looked obviously safe and was hiding the one thing in
 * `src/storage` that chooses between environments.
 */
describe('createBlobStore', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function withEnv(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it('defaults to LOCAL when no provider is configured', () => {
    // The safe default: a missing BLOB_PROVIDER must not silently attempt
    // a remote write with empty credentials.
    withEnv({ BLOB_PROVIDER: undefined });

    expect(createBlobStore()).toBeInstanceOf(LocalBlobStore);
  });

  it('builds an S3 store for an s3-compatible provider', () => {
    withEnv({
      BLOB_PROVIDER: 'r2',
      BLOB_ACCOUNT: 'acct',
      [BLOB_CREDENTIAL_ENV.accessKeyId]: 'key',
      [BLOB_CREDENTIAL_ENV.secretAccessKey]: 'secret',
    });

    expect(createBlobStore()).toBeInstanceOf(S3BlobStore);
  });

  it('THROWS on an unknown provider, naming the valid ones', () => {
    // Falling back to local here would be worse than failing: uploads
    // would appear to succeed while going somewhere nothing serves them.
    withEnv({ BLOB_PROVIDER: 'dropbox' });

    expect(() => createBlobStore()).toThrow(/Unknown BLOB_PROVIDER/);
    expect(() => createBlobStore()).toThrow(/local/);
  });

  it('propagates a missing-credential failure rather than degrading', () => {
    // resolveBlobCredentials reads by env var NAME and throws when unset.
    // The factory must not swallow that -- a remote provider configured
    // without credentials is a misconfiguration to surface at boot.
    withEnv({
      BLOB_PROVIDER: 'r2',
      BLOB_ACCOUNT: 'acct',
      [BLOB_CREDENTIAL_ENV.accessKeyId]: undefined,
      [BLOB_CREDENTIAL_ENV.secretAccessKey]: undefined,
    });

    expect(() => createBlobStore()).toThrow();
  });

  it('never puts a credential VALUE in the error it throws', () => {
    // Same discipline as @medinstru/config's resolveApiKey: an error that
    // names the variable is useful, one that quotes the value leaks it into
    // every log that captured the boot failure.
    //
    // BLOB_ACCOUNT is set explicitly so the only thing missing is the
    // secret -- otherwise an unrelated endpoint/account error could throw
    // first and this would pass without ever reaching the credential path.
    withEnv({
      BLOB_PROVIDER: 'r2',
      BLOB_ACCOUNT: 'acct',
      [BLOB_CREDENTIAL_ENV.accessKeyId]: 'AKIAREALLOOKINGKEY',
      [BLOB_CREDENTIAL_ENV.secretAccessKey]: undefined,
    });

    // Captured rather than asserted inside a catch block: an assertion that
    // only runs on the error path passes vacuously if no error is thrown,
    // which is the exact failure mode this whole test exists to rule out.
    let caught: unknown;
    try {
      createBlobStore();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain(BLOB_CREDENTIAL_ENV.secretAccessKey);
    expect(String(caught)).not.toContain('AKIAREALLOOKINGKEY');
  });
});
