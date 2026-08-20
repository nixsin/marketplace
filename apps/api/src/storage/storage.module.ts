import { Global, Module } from '@nestjs/common';
import { join } from 'node:path';
import {
  BLOB_ACCOUNT,
  BLOB_BUCKET,
  BLOB_PROVIDER,
  BLOB_PROVIDERS,
  BLOB_REGION,
  blobEndpoint,
  blobUrl,
  resolveBlobCredentials,
} from '@medinstru/config';
import { BLOB_STORE, type BlobStore } from './blob-store';
import { LocalBlobStore } from './local-blob-store';
import { S3BlobStore } from './s3-blob-store';

/**
 * Chooses an adapter from configuration alone.
 *
 * Note what is NOT here: any per-provider branching. R2, S3, B2, Spaces,
 * MinIO and Wasabi all take the same path, differing only in the endpoint
 * and region that @medinstru/config computes for them. Adding one of those
 * providers requires no change to this file at all -- only a provider
 * that does not speak S3 would, and then it is one new adapter and one
 * new branch, not edits scattered through the app.
 */
export function createBlobStore(): BlobStore {
  const provider = BLOB_PROVIDERS[BLOB_PROVIDER];
  if (!provider) {
    throw new Error(
      `Unknown BLOB_PROVIDER "${BLOB_PROVIDER}" -- expected one of: ${Object.keys(
        BLOB_PROVIDERS,
      ).join(', ')}`,
    );
  }

  if (!provider.s3Compatible) {
    // Local development and CI. Files live under apps/web/public so the
    // dev server serves them at the same paths blobUrl() produces,
    // meaning the local path and the deployed path behave identically.
    return new LocalBlobStore(
      join(process.cwd(), '..', 'web', 'public'),
      blobUrl,
    );
  }

  // Read at construction, not at module load: a missing credential should
  // fail when storage is actually wired up, with a message naming the
  // variable, rather than crashing an unrelated import.
  const { accessKeyId, secretAccessKey } = resolveBlobCredentials();

  return new S3BlobStore({
    bucket: BLOB_BUCKET,
    endpoint: blobEndpoint(),
    region: BLOB_REGION || provider.region,
    accessKeyId,
    secretAccessKey,
    toPublicUrl: blobUrl,
  });
}

/**
 * Global so any module can inject BLOB_STORE without importing this one.
 *
 * Providers are always injected by the BLOB_STORE token, never by a
 * concrete class -- that is what keeps callers unaware of which adapter
 * is in play, and what makes a provider switch invisible to them.
 */
@Global()
@Module({
  providers: [{ provide: BLOB_STORE, useFactory: createBlobStore }],
  exports: [BLOB_STORE],
})
export class StorageModule {}

// Referenced by the factory error message above; re-exported so callers
// have one import site for the token and the port together.
export { BLOB_STORE, type BlobStore } from './blob-store';
export { BLOB_ACCOUNT };
