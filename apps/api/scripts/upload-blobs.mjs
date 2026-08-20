#!/usr/bin/env node
/**
 * Uploads the committed product images to the configured blob store.
 *
 * Run by a human with real credentials in their shell -- never in CI, and
 * never with credentials written to a file:
 *
 *   BLOB_PROVIDER=r2 BLOB_ACCOUNT=<account> BLOB_BUCKET=medinstru-media \
 *   BLOB_ACCESS_KEY_ID=... BLOB_SECRET_ACCESS_KEY=... \
 *   node apps/api/scripts/upload-blobs.mjs [--dry-run]
 *
 * Lives under apps/api because that is where the S3 client is installed --
 * the repo root has no such dependency, and adding one there just for a
 * one-off migration would put it in every install.
 *
 * Idempotent: an object already present with the same key is skipped
 * rather than re-uploaded, so a partial run can simply be re-run. Pass
 * --force to overwrite.
 *
 * Deliberately NOT wired into a deploy. Uploading assets is a one-off
 * migration a person decides to perform, and making it automatic would
 * mean every deploy holds credentials it does not otherwise need.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOB_BUCKET,
  BLOB_PROVIDER,
  BLOB_PROVIDERS,
  BLOB_REGION,
  blobEndpoint,
  resolveBlobCredentials,
} from "@medinstru/config";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const root = fileURLToPath(new URL("../../web/public/products", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

const provider = BLOB_PROVIDERS[BLOB_PROVIDER];
if (!provider?.s3Compatible) {
  console.error(
    `BLOB_PROVIDER is "${BLOB_PROVIDER}". Set it to an S3-compatible provider ` +
      `(${Object.keys(BLOB_PROVIDERS).filter((p) => BLOB_PROVIDERS[p].s3Compatible).join(", ")}).`,
  );
  process.exit(1);
}

// Fails here, naming only the variable, if credentials are absent.
const { accessKeyId, secretAccessKey } = resolveBlobCredentials();

const client = new S3Client({
  region: BLOB_REGION || provider.region || "auto",
  ...(blobEndpoint() ? { endpoint: blobEndpoint() } : {}),
  forcePathStyle: Boolean(blobEndpoint()),
  credentials: { accessKeyId, secretAccessKey },
});

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BLOB_BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
      return false;
    }
    throw error;
  }
}

const files = (await readdir(root)).filter((f) => extname(f) in CONTENT_TYPES);
if (files.length === 0) {
  console.error(`No uploadable files found in ${root}`);
  process.exit(1);
}

let uploaded = 0;
let skipped = 0;

for (const file of files) {
  const key = `products/${file}`;
  const contentType = CONTENT_TYPES[extname(file)];

  if (!force && (await exists(key))) {
    console.log(`  skip     ${key} (already present)`);
    skipped++;
    continue;
  }
  if (dryRun) {
    console.log(`  would upload ${key} (${contentType})`);
    continue;
  }

  await client.send(
    new PutObjectCommand({
      Bucket: BLOB_BUCKET,
      Key: key,
      Body: await readFile(join(root, file)),
      ContentType: contentType,
      // Long-lived: these filenames are stable, and the images are
      // immutable in practice. A changed image gets a new filename.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  console.log(`  uploaded ${key}`);
  uploaded++;
}

console.log(
  `\n${dryRun ? "Dry run: " : ""}${uploaded} uploaded, ${skipped} skipped, ` +
    `${files.length} total in bucket "${BLOB_BUCKET}" (${BLOB_PROVIDER}).`,
);
if (!dryRun && uploaded > 0) {
  console.log(
    "Next: set NEXT_PUBLIC_BLOB_BASE_URL to the public URL for this bucket, " +
      "then redeploy so image URLs point at it.",
  );
}
