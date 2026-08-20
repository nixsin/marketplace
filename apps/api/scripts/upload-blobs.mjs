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
// Env is read directly rather than importing the app's TypeScript config:
// this is a standalone .mjs migration tool run by a person, and keeping it
// dependency-light means it works from a plain checkout without a build.
// The provider table is duplicated in miniature below and kept honest by
// a test that asserts it matches src/storage/blob-config.ts.
const BLOB_PROVIDER = process.env.BLOB_PROVIDER || "local";
const BLOB_BUCKET = process.env.BLOB_BUCKET || "medinstru-media";
const BLOB_REGION = process.env.BLOB_REGION || "";

const BLOB_PROVIDERS = {
  r2: { s3Compatible: true, endpoint: "https://{account}.r2.cloudflarestorage.com", region: "auto" },
  s3: { s3Compatible: true, endpoint: "", region: "" },
  b2: { s3Compatible: true, endpoint: "https://s3.{region}.backblazeb2.com", region: "" },
  spaces: { s3Compatible: true, endpoint: "https://{region}.digitaloceanspaces.com", region: "" },
  minio: { s3Compatible: true, endpoint: "", region: "us-east-1" },
  local: { s3Compatible: false, endpoint: "", region: "" },
};

function blobEndpoint() {
  if (process.env.BLOB_ENDPOINT) return process.env.BLOB_ENDPOINT;
  const p = BLOB_PROVIDERS[BLOB_PROVIDER];
  if (!p) return "";
  return p.endpoint
    .replace("{account}", process.env.BLOB_ACCOUNT || "")
    .replace("{region}", BLOB_REGION);
}

function resolveBlobCredentials() {
  const accessKeyId = process.env.BLOB_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BLOB_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    const missing = [
      !accessKeyId ? "BLOB_ACCESS_KEY_ID" : null,
      !secretAccessKey ? "BLOB_SECRET_ACCESS_KEY" : null,
    ].filter(Boolean);
    // Names the variable, never any part of the value.
    throw new Error(
      `${missing.join(" and ")} not set, required by BLOB_PROVIDER="${BLOB_PROVIDER}". ` +
        "Export them in your shell.",
    );
  }
  return { accessKeyId, secretAccessKey };
}
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
