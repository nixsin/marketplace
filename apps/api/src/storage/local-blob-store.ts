import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { assertValidKey, type BlobStore } from './blob-store';

/**
 * Filesystem-backed storage.
 *
 * This is the DEFAULT, not a degraded fallback. Local development and CI
 * need no cloud account, no credentials and no network to exercise the
 * full upload path, and this whole feature can therefore land without
 * changing any behaviour until a provider is actually configured.
 *
 * It is also what makes the port testable: every test below runs against
 * a real implementation rather than a mock that could drift from one.
 */
export class LocalBlobStore implements BlobStore {
  /**
   * `toPublicUrl` is injected rather than imported, so this adapter has no
   * dependency on global configuration. That keeps it a pure unit -- every
   * test below runs the real class with no environment to arrange -- and
   * it keeps the ESM-only @medinstru/config out of a CommonJS module,
   * which Jest's runtime cannot load even though Node itself can.
   */
  constructor(
    private readonly root: string,
    private readonly toPublicUrl: (key: string) => string,
  ) {}

  /**
   * Resolves a key to a path, refusing anything outside the root.
   *
   * assertValidKey already rejects traversal, so this is a second,
   * independent check rather than the only one -- the consequence of
   * being wrong here is writing to an arbitrary filesystem location, and
   * a single regex is a thin thing to stake that on. Compares resolved
   * absolute paths, which is the check that holds regardless of how the
   * key was spelled.
   */
  private pathFor(key: string): string {
    assertValidKey(key);
    const root = resolve(this.root);
    const full = resolve(join(root, key));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`Blob key escapes the storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      // Only a genuinely missing file means "not found". Anything else --
      // a permission error, a corrupt filesystem -- must surface, not be
      // silently reported as an absent object.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // force: true makes deleting a missing key a no-op, matching S3's
    // own semantics so callers behave identically across adapters.
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  publicUrl(key: string): string {
    assertValidKey(key);
    return this.toPublicUrl(key);
  }
}
