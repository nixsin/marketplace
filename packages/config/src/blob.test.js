import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOB_CREDENTIAL_ENV,
  BLOB_PROVIDERS,
  blobEndpoint,
  blobUrl,
  resolveBlobCredentials,
} from "./index.js";

test("blobUrl falls back to a root-relative path when no provider is set", () => {
  // This is what keeps the currently-committed images working unchanged:
  // the feature can land with zero behaviour change until a provider is
  // actually configured.
  assert.equal(blobUrl("products/x.png", ""), "/products/x.png");
  assert.equal(blobUrl("/products/x.png", ""), "/products/x.png");
});

test("blobUrl joins against a configured base without doubling slashes", () => {
  assert.equal(
    blobUrl("products/x.png", "https://images.laxair.shop"),
    "https://images.laxair.shop/products/x.png",
  );
  assert.equal(
    blobUrl("/products/x.png", "https://images.laxair.shop/"),
    "https://images.laxair.shop/products/x.png",
  );
});

test("every S3-compatible provider resolves an endpoint from config alone", () => {
  // The portability claim, asserted rather than described: switching
  // provider is a config change, and none of these needs new code.
  const cases = [
    [{ BLOB_PROVIDER: "r2", BLOB_ACCOUNT: "acc123" },
     "https://acc123.r2.cloudflarestorage.com"],
    [{ BLOB_PROVIDER: "b2", BLOB_REGION: "us-west-004" },
     "https://s3.us-west-004.backblazeb2.com"],
    [{ BLOB_PROVIDER: "spaces", BLOB_REGION: "blr1" },
     "https://blr1.digitaloceanspaces.com"],
    [{ BLOB_PROVIDER: "s3", BLOB_REGION: "ap-south-1" }, ""],
  ];
  for (const [env, expected] of cases) {
    assert.equal(blobEndpoint(env), expected, `for ${env.BLOB_PROVIDER}`);
  }
});

test("an explicit endpoint overrides the provider template", () => {
  // Required for MinIO and for any self-hosted or proxied deployment.
  assert.equal(
    blobEndpoint({ BLOB_PROVIDER: "r2", BLOB_ENDPOINT: "http://localhost:9000" }),
    "http://localhost:9000",
  );
});

test("every provider except local speaks S3, so one adapter covers them", () => {
  for (const [name, provider] of Object.entries(BLOB_PROVIDERS)) {
    assert.equal(
      provider.s3Compatible,
      name !== "local",
      `${name} should ${name === "local" ? "not " : ""}be S3-compatible`,
    );
  }
});

test("credential config carries env var NAMES, never values", () => {
  // packages/config is committed, so a value here would enter git history
  // permanently and be readable by every CI job.
  const serialised = JSON.stringify(BLOB_CREDENTIAL_ENV);
  assert.ok(!/[A-Za-z0-9+/]{32,}/.test(serialised), "looks like a secret");
  assert.equal(BLOB_CREDENTIAL_ENV.accessKeyId, "BLOB_ACCESS_KEY_ID");
});

test("resolveBlobCredentials reads by name at call time", () => {
  const creds = resolveBlobCredentials({
    BLOB_ACCESS_KEY_ID: "id-1",
    BLOB_SECRET_ACCESS_KEY: "secret-1",
  });
  assert.deepEqual(creds, { accessKeyId: "id-1", secretAccessKey: "secret-1" });
});

test("a missing credential names the variable but never the value", () => {
  // A misconfiguration must not leak a partially-set key into a public CI
  // log -- the same rule resolveApiKey follows.
  assert.throws(
    () => resolveBlobCredentials({ BLOB_ACCESS_KEY_ID: "id-1", BLOB_PROVIDER: "r2" }),
    (error) => {
      assert.match(error.message, /BLOB_SECRET_ACCESS_KEY/);
      assert.ok(!error.message.includes("id-1"), "leaked the access key id");
      return true;
    },
  );
});
