import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertValidKey, type BlobStore } from './blob-store';
import { LocalBlobStore } from './local-blob-store';

describe('assertValidKey', () => {
  it('accepts the keys we actually use', () => {
    expect(() => assertValidKey('products/lab-equipment.png')).not.toThrow();
    expect(() => assertValidKey('uploads/seller-1/photo_2.jpg')).not.toThrow();
  });

  it('rejects path traversal', () => {
    // Keys will come from seller uploads (#93), so this is untrusted
    // input. An S3 store treats "../.." as an opaque string harmlessly,
    // but the local adapter joins the same key into a filesystem path.
    expect(() => assertValidKey('../etc/passwd')).toThrow(/traversal/);
    expect(() => assertValidKey('products/../../secrets')).toThrow(/traversal/);
    expect(() => assertValidKey('./products/x.png')).toThrow(/traversal/);
  });

  it('rejects leading and trailing slashes', () => {
    expect(() => assertValidKey('/products/x.png')).toThrow();
    expect(() => assertValidKey('products/')).toThrow();
  });

  it('rejects control characters and backslashes', () => {
    // Control characters break HTTP headers and log lines; backslash is a
    // path separator on some filesystems.
    expect(() => assertValidKey('products/a\\nb.png')).toThrow(/forbidden/);
    expect(() => assertValidKey('products\\\\x.png')).toThrow(/forbidden/);
  });

  it('rejects empty and oversized keys', () => {
    expect(() => assertValidKey('')).toThrow();
    expect(() => assertValidKey('a'.repeat(1025))).toThrow();
    expect(() => assertValidKey('a'.repeat(1024))).not.toThrow();
  });
});

describe('LocalBlobStore', () => {
  let root: string;
  // Typed as the PORT, not the concrete class: these tests are the
  // contract every adapter must satisfy, so an S3 adapter test can reuse
  // them verbatim rather than re-deriving what correct behaviour is.
  let store: BlobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'blob-'));
    // A stub URL builder: the adapter takes one rather than importing
    // global config, so this test needs no environment at all.
    store = new LocalBlobStore(root, (key) => `/${key}`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips an object', async () => {
    await store.put('products/x.png', Buffer.from('hello'), 'image/png');
    expect((await store.get('products/x.png'))?.toString()).toBe('hello');
  });

  it('creates nested directories as needed', async () => {
    await store.put('a/b/c/d.png', Buffer.from('deep'), 'image/png');
    expect(await readFile(join(root, 'a/b/c/d.png'), 'utf8')).toBe('deep');
  });

  it('overwrites an existing key, matching S3 semantics', async () => {
    await store.put('x.png', Buffer.from('first'), 'image/png');
    await store.put('x.png', Buffer.from('second'), 'image/png');
    expect((await store.get('x.png'))?.toString()).toBe('second');
  });

  it('returns null for a missing key rather than throwing', async () => {
    expect(await store.get('nope.png')).toBeNull();
  });

  it('reports existence without transferring the object', async () => {
    await store.put('x.png', Buffer.from('a'), 'image/png');
    expect(await store.exists('x.png')).toBe(true);
    expect(await store.exists('missing.png')).toBe(false);
  });

  it('deletes, and deleting a missing key is a no-op like S3', async () => {
    await store.put('x.png', Buffer.from('a'), 'image/png');
    await store.delete('x.png');
    expect(await store.exists('x.png')).toBe(false);
    await expect(store.delete('x.png')).resolves.toBeUndefined();
  });

  it('refuses to write outside its root', async () => {
    // Second, independent check beyond assertValidKey: being wrong here
    // means writing to an arbitrary filesystem location, which is too
    // much to stake on one regex.
    await expect(
      store.put('../escaped.png', Buffer.from('x'), 'image/png'),
    ).rejects.toThrow();
    await expect(store.get('../../etc/passwd')).rejects.toThrow();
  });

  it('builds a public URL from the key', () => {
    // With no provider configured this is the existing root-relative
    // path, which is what keeps committed images working unchanged.
    expect(store.publicUrl('products/lab-equipment.png')).toBe(
      '/products/lab-equipment.png',
    );
  });
});
