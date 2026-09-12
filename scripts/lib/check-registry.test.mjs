import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRegistry,
  isPackageMetadata,
  registryOrigin,
  PROBE_PACKAGE,
} from "./check-registry.mjs";

/** A fetch double. `body` is sent verbatim so malformed shapes are testable. */
function fakeFetch({ status = 200, body = JSON.stringify({ name: PROBE_PACKAGE }), throws } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw throws;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("registryOrigin drops userinfo, which is the whole point", () => {
  // The caller logs this value into a public workflow log, so a registry
  // URL carrying credentials must not survive. Raised in review.
  assert.equal(
    registryOrigin("https://user:secret@registry.example.com/path/"),
    "https://registry.example.com",
  );
});

test("registryOrigin refuses anything that is not a fetchable http(s) URL", () => {
  for (const bad of ["", "   ", undefined, null, 42, "registry.npmjs.org", "/local", "ftp://x.example", "data:,x"]) {
    assert.equal(registryOrigin(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("isPackageMetadata refuses a 200 that is not the package document", () => {
  // The failure this exists for: a captive portal, proxy error page or
  // login screen all answer 200, and discarding the body accepts them all.
  assert.equal(isPackageMetadata('{"name":"semver"}'), true);
  for (const bad of [
    "<html><body>Sign in</body></html>",
    "",
    "null",
    "[]",
    '"a string"',
    '{"name":"something-else"}',
    "{not json",
  ]) {
    assert.equal(isPackageMetadata(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

test("a healthy registry passes, and the probe actually leaves the machine", async () => {
  const fetchImpl = fakeFetch();
  const result = await checkRegistry({ registry: "https://registry.npmjs.org/", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.origin, "https://registry.npmjs.org");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `https://registry.npmjs.org/${PROBE_PACKAGE}`);
});

test("redirects are FOLLOWED, not counted as success", async () => {
  // The shell version used bare curl, which treats a 3xx as success
  // WITHOUT fetching the destination -- so a redirect anywhere passed the
  // probe. Raised in review.
  const fetchImpl = fakeFetch();
  await checkRegistry({ registry: "https://registry.npmjs.org/", fetchImpl });
  assert.equal(fetchImpl.calls[0].options.redirect, "follow");
});

test("a 2xx carrying an HTML login page is REFUSED", async () => {
  const result = await checkRegistry({
    registry: "https://registry.npmjs.org/",
    fetchImpl: fakeFetch({ body: "<html>Sign in</html>" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not return/);
});

test("a non-2xx is refused and names the status", async () => {
  const result = await checkRegistry({
    registry: "https://registry.npmjs.org/",
    fetchImpl: fakeFetch({ status: 401 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /401/);
});

test("a missing registry is a clean refusal, not a throw", async () => {
  // This is how `pnpm config get registry` FAILING reaches us: the
  // workflow passes whatever it got, including nothing. Under the shell
  // version that case aborted the step with pnpm's own status, which
  // collides with exit 1's meaning. Raised in review.
  for (const registry of ["", undefined]) {
    const result = await checkRegistry({ registry, fetchImpl: fakeFetch() });
    assert.equal(result.ok, false);
    assert.equal(result.origin, null);
    assert.match(result.reason, /no usable registry/);
  }
});

test("a network error is a reason, never a rejection", async () => {
  const result = await checkRegistry({
    registry: "https://registry.npmjs.org/",
    fetchImpl: fakeFetch({ throws: new TypeError("fetch failed") }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unreachable/);
});

test("a hang is bounded and reported as a timeout", async () => {
  // Without this the job sits until GitHub's own timeout, which reads as a
  // runner problem rather than a registry one.
  const result = await checkRegistry({
    registry: "https://registry.npmjs.org/",
    timeoutMs: 20,
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timed out");
});

test("the reason never carries the configured registry, only its origin", async () => {
  const result = await checkRegistry({
    registry: "https://user:secret@registry.example.com/",
    fetchImpl: fakeFetch({ status: 500 }),
  });
  assert.equal(result.origin, "https://registry.example.com");
  assert.doesNotMatch(`${result.origin} ${result.reason}`, /secret/);
});
