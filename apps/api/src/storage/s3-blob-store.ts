import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertValidKey, type BlobStore } from './blob-store';

export interface S3BlobStoreOptions {
  bucket: string;
  /** Empty for AWS S3, which derives its own endpoint from the region. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injected, not imported -- see LocalBlobStore for why. */
  toPublicUrl: (key: string) => string;
}

/**
 * Storage for any S3-compatible provider.
 *
 * One adapter covers Cloudflare R2, AWS S3, Backblaze B2, DigitalOcean
 * Spaces, MinIO and Wasabi, because they all implement the same API.
 * Moving between them is a config change -- endpoint, region, bucket,
 * credentials -- and touches no code here. There is deliberately no
 * `if (provider === "r2")` anywhere in this file; the moment one appears,
 * the portability claim stops being true.
 *
 * `forcePathStyle` is the one setting worth understanding. S3 addresses
 * buckets as a subdomain (bucket.s3.amazonaws.com) by default; R2 and
 * MinIO expect the bucket in the path instead. Deriving it from whether a
 * custom endpoint was supplied gets both right without naming providers:
 * a custom endpoint means a non-AWS provider, which in practice means
 * path style.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly toPublicUrl: (key: string) => string;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.toPublicUrl = options.toPublicUrl;
    this.client = new S3Client({
      region: options.region || 'auto',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * The CDN or custom-domain URL, NOT the S3 endpoint.
   *
   * The S3 endpoint generally requires signed requests, and signing every
   * image URL would make them uncacheable and expiring -- wrong for a
   * public catalog. Public reads are served from a separate public base
   * URL (images.laxair.shop, or an R2 public bucket URL).
   */
  publicUrl(key: string): string {
    assertValidKey(key);
    return this.toPublicUrl(key);
  }
}

/**
 * Whether an error means "no such object".
 *
 * Providers disagree on how they say it: S3 returns NoSuchKey for GET but
 * a bare 404 with no code for HEAD, and others use NotFound. Checking the
 * HTTP status as well as the name is what keeps this portable -- matching
 * only on `name` works against S3 and then silently reports every missing
 * object as a hard error on another provider.
 */
function isNotFound(error: unknown): boolean {
  const err = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404
  );
}
