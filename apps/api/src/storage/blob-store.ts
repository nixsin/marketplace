/**
 * The storage port.
 *
 * Everything in the app talks to this interface, never to a provider SDK.
 * That is what makes swapping providers a contained change rather than a
 * search-and-replace across the codebase.
 *
 * Two layers of portability, and it is worth being clear that the first
 * does most of the work:
 *
 * 1. THE PROTOCOL. Cloudflare R2, AWS S3, Backblaze B2, DigitalOcean
 *    Spaces, MinIO and Wasabi all speak the S3 API. One adapter with a
 *    configurable endpoint therefore covers all of them, and moving
 *    between them is a config change with no code change at all.
 *
 * 2. THIS INTERFACE. A provider that does NOT speak S3 -- Azure Blob, GCS
 *    native -- needs one new adapter implementing these five methods, and
 *    nothing else in the app changes.
 *
 * Kept deliberately small. Every method here must be implementable by any
 * plausible provider; anything provider-specific (lifecycle rules,
 * storage classes, replication) stays out, because a port is only as
 * portable as its narrowest member.
 */
export interface BlobStore {
  /** Stores an object, overwriting any existing object at the same key. */
  put(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void>;

  /** Retrieves an object, or null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;

  /** Removes an object. Succeeds whether or not the key existed. */
  delete(key: string): Promise<void>;

  /** Whether an object exists, without transferring it. */
  exists(key: string): Promise<boolean>;

  /**
   * The public URL a browser fetches this object from.
   *
   * Synchronous and non-throwing, because it is called while rendering
   * markup -- a product listing builds one of these per card, and an
   * await or a throw in that path would be badly placed.
   */
  publicUrl(key: string): string;
}

/** Injection token -- the app depends on the port, never on an adapter. */
export const BLOB_STORE = Symbol('BLOB_STORE');

/**
 * Rejects keys that would escape their intended prefix or break URLs.
 *
 * Keys will come from seller uploads (see #93), so this is untrusted
 * input. S3-compatible stores treat a key as an opaque string and will
 * happily store "../../etc/passwd" -- harmless there, but the same key is
 * later joined into a filesystem path by the local adapter, where it is
 * not harmless at all. Validating once at the port means every adapter
 * inherits the guarantee instead of each re-deriving it.
 */
export function assertValidKey(key: string): void {
  if (!key || key.length > 1024) {
    throw new Error('Blob key must be between 1 and 1024 characters');
  }
  if (key.startsWith('/') || key.endsWith('/')) {
    throw new Error(`Blob key must not start or end with "/": ${key}`);
  }
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Blob key must not contain path traversal: ${key}`);
  }
  // Control characters break HTTP headers and log lines alike; backslash
  // is a path separator on some filesystems the local adapter may run on.
  //
  // Checked by code point rather than a regex: matching control characters
  // is exactly what eslint's no-control-regex flags, and the rule is right
  // that such a regex is usually a mistake. Here it is intentional, so the
  // clearer move is to say so in code rather than silence the rule.
  for (const char of key) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || char === '\\') {
      throw new Error(`Blob key contains forbidden characters: ${key}`);
    }
  }
}
