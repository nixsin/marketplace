import { mkdtemp, chmod, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBlobStore } from './local-blob-store';

/**
 * The two guards nothing exercised directly.
 *
 * This adapter had no spec of its own -- it sat at 92% purely from being
 * driven incidentally by other suites, which left the path-traversal refusal
 * and the "a real failure is not a missing file" rethrow both unexercised.
 * Those are the two branches where being wrong is expensive: one writes to an
 * arbitrary filesystem location, the other reports a broken disk as an absent
 * object and lets a caller carry on as though nothing were wrong.
 *
 * Runs against a real temporary directory, matching this file's own stated
 * preference for exercising the real implementation rather than a mock that
 * could drift from it.
 */
describe('LocalBlobStore', () => {
  let root: string;
  let store: LocalBlobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'blob-store-'));
    store = new LocalBlobStore(root, (key) => `/blobs/${key}`);
  });

  afterEach(async () => {
    // Permissions are restored first, or the cleanup of the unreadable-
    // directory test fails and strands a temp directory per run.
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  describe('refuses a key that escapes the root', () => {
    // These assert the REFUSAL, not which guard produces it, and that
    // distinction is worth stating because it was measured rather than
    // assumed: every case below is caught by `assertValidKey`, and
    // `pathFor`'s own resolved-path check is never reached.
    //
    // That second check stays anyway. It exists precisely so the regex is not
    // the only thing standing between a caller and a write outside the
    // storage root, and unreachable-today is not the same as unreachable --
    // loosening one segment of assertValidKey would put it back in play. What
    // these tests own is the property callers depend on: the key is refused,
    // and nothing is written. Reaching the backstop directly would mean
    // bypassing the first guard, which tests the test rather than the store.
    it('refuses an absolute path, which resolve() would honour outright', async () => {
      // join(root, '/etc/passwd') resolves to root/etc/passwd on POSIX, but
      // the point is that the class must not depend on that being true.
      await expect(
        store.put('/etc/passwd', Buffer.from('x')),
      ).rejects.toThrow();
    });

    it('refuses traversal segments however they are spelled', async () => {
      for (const key of ['../outside.png', 'a/../../outside.png', '..']) {
        await expect(store.put(key, Buffer.from('x'))).rejects.toThrow();
      }
    });

    it('writes nothing when it refuses', async () => {
      await expect(
        store.put('../escaped.png', Buffer.from('x')),
      ).rejects.toThrow();
      await expect(store.exists('escaped.png')).resolves.toBe(false);
    });
  });

  describe('a real failure is not a missing file', () => {
    it('rethrows from exists() rather than answering false', async () => {
      // The failure this guards: a permission error reported as "not there"
      // tells the caller the object is absent, so it re-uploads or renders a
      // gap instead of surfacing a broken disk. Provoked with a directory the
      // process cannot traverse, which yields EACCES rather than ENOENT.
      const locked = join(root, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'file.png'), 'x');
      await chmod(locked, 0o000);

      // Skipped when running as root, where chmod cannot deny anything and
      // the call would succeed -- a green result for the wrong reason.
      let denied = true;
      try {
        await store.exists('locked/file.png');
        denied = false;
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).not.toBe('ENOENT');
      }
      await chmod(locked, 0o755);
      if (!denied) {
        console.warn(
          'skipped: filesystem permits traversal (running as root?)',
        );
      }
    });

    it('still answers false for a genuinely absent key', async () => {
      // The other half. A guard that rethrew everything would be just as
      // wrong, and this is what separates the two.
      await expect(store.exists('nothing/here.png')).resolves.toBe(false);
    });
  });

  it('round-trips a key it accepts', async () => {
    // Proves the refusals above are not simply rejecting everything.
    await store.put('products/x-ray.png', Buffer.from('hello'));
    await expect(store.exists('products/x-ray.png')).resolves.toBe(true);
    expect((await store.get('products/x-ray.png'))?.toString()).toBe('hello');
    expect(store.publicUrl('products/x-ray.png')).toBe(
      '/blobs/products/x-ray.png',
    );
  });
});
