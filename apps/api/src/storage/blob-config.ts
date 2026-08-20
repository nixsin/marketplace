/**
 * Blob storage configuration.
 *
 * Lives in apps/api rather than @medinstru/config, deliberately. That
 * package is ESM-only by design -- documented as serving two consumers
 * with incompatible needs, apps/web (which compiles it through
 * TypeScript) and scripts/*.mjs (plain Node ESM). apps/api is CommonJS,
 * a third and incompatible need it was never built for: Node itself
 * handles the boundary fine (require(ESM) works on 22.12+ and the image
 * is node:26), but Jest's own module runtime does not, and forcing it
 * through meant contorting two Jest configs to transpile a file outside
 * their rootDir. Owning ~40 lines here is the smaller cost.
 *
 * Nothing is duplicated as a result. apps/web needs exactly one value
 * from this domain -- the public base URL for building <img> URLs -- and
 * reads that single env var directly. There is no shared derived logic
 * for the two to drift apart on.
 *
 * PORTABILITY: almost every object store speaks the S3 API -- R2, S3,
 * Backblaze B2, DigitalOcean Spaces, MinIO, Wasabi -- so talking S3 with
 * a configurable endpoint makes switching provider a config change. The
 * table below differs only in endpoint shape and region convention, and
 * there is deliberately no per-provider branching anywhere in the code.
 */

export interface BlobProviderSpec {
  /** Whether it speaks S3, and so needs no new adapter. */
  s3Compatible: boolean;
  /** Endpoint template; `{account}` and `{region}` are substituted. */
  endpoint: string;
  /** The provider's own region convention. */
  region: string;
}

export const BLOB_PROVIDERS: Record<string, BlobProviderSpec> = {
  /** Cloudflare R2. No egress fees, which is why it is the first choice. */
  r2: {
    s3Compatible: true,
    // R2 keys the host on an account id, and requires the literal region
    // "auto" -- exactly the kind of detail that otherwise surfaces as a
    // confusing SignatureDoesNotMatch.
    endpoint: 'https://{account}.r2.cloudflarestorage.com',
    region: 'auto',
  },
  s3: { s3Compatible: true, endpoint: '', region: '' },
  b2: {
    s3Compatible: true,
    endpoint: 'https://s3.{region}.backblazeb2.com',
    region: '',
  },
  spaces: {
    s3Compatible: true,
    endpoint: 'https://{region}.digitaloceanspaces.com',
    region: '',
  },
  minio: { s3Compatible: true, endpoint: '', region: 'us-east-1' },
  /**
   * The filesystem. The DEFAULT, not a degraded fallback: local
   * development and CI need no cloud account, no credentials and no
   * network, and this feature lands without changing any behaviour until
   * a provider is actually configured.
   */
  local: { s3Compatible: false, endpoint: '', region: '' },
};

/** Credential env var NAMES -- never the values, which stay in the shell. */
export const BLOB_CREDENTIAL_ENV = {
  accessKeyId: 'BLOB_ACCESS_KEY_ID',
  secretAccessKey: 'BLOB_SECRET_ACCESS_KEY',
} as const;

export function blobProviderName(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLOB_PROVIDER || 'local';
}

/** The S3 endpoint for the configured provider, or "" when not applicable. */
export function blobEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BLOB_ENDPOINT) return env.BLOB_ENDPOINT;
  const provider = BLOB_PROVIDERS[blobProviderName(env)];
  if (!provider) return '';
  return provider.endpoint
    .replace('{account}', env.BLOB_ACCOUNT || '')
    .replace('{region}', env.BLOB_REGION || '');
}

/**
 * The public URL for a stored object.
 *
 * Falls back to a root-relative path when no base URL is configured,
 * which is what keeps the currently-committed images working unchanged:
 * `products/x.png` resolves to `/products/x.png`, exactly what
 * apps/web/public already serves.
 */
export function blobUrl(
  key: string,
  baseUrl = process.env.NEXT_PUBLIC_BLOB_BASE_URL ||
    process.env.BLOB_PUBLIC_BASE_URL ||
    '',
): string {
  const clean = String(key).replace(/^\/+/, '');
  if (!baseUrl) return `/${clean}`;
  return `${baseUrl.replace(/\/+$/, '')}/${clean}`;
}

/**
 * Reads credentials by name at call time.
 *
 * Throws naming only the variable, never any part of the value, so a
 * misconfiguration cannot leak a partially-set key into a public CI log.
 */
export function resolveBlobCredentials(env: NodeJS.ProcessEnv = process.env): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const accessKeyId = env[BLOB_CREDENTIAL_ENV.accessKeyId];
  const secretAccessKey = env[BLOB_CREDENTIAL_ENV.secretAccessKey];
  if (!accessKeyId || !secretAccessKey) {
    const missing = [
      !accessKeyId ? BLOB_CREDENTIAL_ENV.accessKeyId : null,
      !secretAccessKey ? BLOB_CREDENTIAL_ENV.secretAccessKey : null,
    ].filter(Boolean);
    throw new Error(
      `${missing.join(' and ')} not set, required by BLOB_PROVIDER="${blobProviderName(env)}". ` +
        'In CI they come from GitHub repo secrets; locally, export them in your shell.',
    );
  }
  return { accessKeyId, secretAccessKey };
}
