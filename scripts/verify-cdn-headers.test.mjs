import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPath } from "./verify-cdn-headers.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// Builds a fake fetch response with just enough shape for checkPath:
// .status, .url (the *final* URL after any redirect -- real fetch()
// exposes this), and .headers with a real Headers-compatible .entries().
function fakeResponse({ status = 200, url, headers = {} }) {
  return { status, url, headers: new Headers(headers) };
}

// A fetchImpl stub keyed by URL -- lets each test declare exactly what
// each of the two parallel requests checkPath fires should return,
// without any real network access.
function stubFetch(responsesByUrl) {
  return async (url) => {
    const response = responsesByUrl[url];
    if (!response) throw new Error(`stubFetch: no fixture registered for ${url}`);
    return response;
  };
}

test("checkPath: matching headers on healthy responses passes", async () => {
  const fetchImpl = stubFetch({
    "https://origin.example.com/en": fakeResponse({
      url: "https://origin.example.com/en",
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
    "https://cdn.example.com/en": fakeResponse({
      url: "https://cdn.example.com/en",
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
  });
  const ok = await checkPath(
    "https://origin.example.com",
    "https://cdn.example.com",
    "/en",
    fetchImpl,
  );
  assert.equal(ok, true);
});

test("checkPath: a real AI review found this exact gap -- two failing (500) responses with no cache-control must not silently pass", async () => {
  const fetchImpl = stubFetch({
    "https://origin.example.com/en": fakeResponse({
      status: 500,
      url: "https://origin.example.com/en",
    }),
    "https://cdn.example.com/en": fakeResponse({
      status: 500,
      url: "https://cdn.example.com/en",
    }),
  });
  const ok = await checkPath(
    "https://origin.example.com",
    "https://cdn.example.com",
    "/en",
    fetchImpl,
  );
  assert.equal(ok, false);
});

test("checkPath: a CDN URL that redirects through to the origin host fails, not passes -- the other gap the same review found", async () => {
  const fetchImpl = stubFetch({
    "https://origin.example.com/en": fakeResponse({
      url: "https://origin.example.com/en",
      headers: { "cache-control": "public, max-age=0" },
    }),
    // The CDN request was sent to cdn.example.com, but fetch's own
    // redirect:"follow" landed it on the origin host -- res.url reflects
    // that, exactly as real fetch() would report it.
    "https://cdn.example.com/en": fakeResponse({
      url: "https://origin.example.com/en",
      headers: { "cache-control": "public, max-age=0" },
    }),
  });
  const ok = await checkPath(
    "https://origin.example.com",
    "https://cdn.example.com",
    "/en",
    fetchImpl,
  );
  assert.equal(ok, false);
});

test("checkPath: mismatched cache-control fails", async () => {
  const fetchImpl = stubFetch({
    "https://origin.example.com/en": fakeResponse({
      url: "https://origin.example.com/en",
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
    "https://cdn.example.com/en": fakeResponse({
      url: "https://cdn.example.com/en",
      headers: { "cache-control": "public, max-age=86400" },
    }),
  });
  const ok = await checkPath(
    "https://origin.example.com",
    "https://cdn.example.com",
    "/en",
    fetchImpl,
  );
  assert.equal(ok, false);
});

test("checkPath: a stalled response is aborted after requestTimeoutMs, not left to hang forever -- a fifth review round found checkPath had no timeout at all", async () => {
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
      // Never resolves on its own -- simulates a genuinely stalled
      // request with no server-side timeout of its own.
    });
  await assert.rejects(
    () => checkPath("https://origin.example.com", "https://cdn.example.com", "/en", fetchImpl, 10),
    /aborted/i,
  );
});

test("checkPath: an absolute-URL path argument is rejected, not silently allowed to override both bases -- a sixth review round found this could send both requests to the same unrelated host with matching (absent) headers and no redirect involved, exactly the case the round-5 same-host guard is designed to let through as OK", async () => {
  const fetchImpl = async () => {
    throw new Error("fetchImpl should never be called -- the path should be rejected before any request is made");
  };
  await assert.rejects(
    () => checkPath("https://origin.example.com", "https://cdn.example.com", "https://evil.example.com/en", fetchImpl),
    /resolved to host "evil\.example\.com"/,
  );
});

test("checkPath: a protocol-relative path argument (//host/path) is also rejected -- it overrides the host the same way an absolute URL does", async () => {
  const fetchImpl = async () => {
    throw new Error("fetchImpl should never be called -- the path should be rejected before any request is made");
  };
  await assert.rejects(
    () => checkPath("https://origin.example.com", "https://cdn.example.com", "//evil.example.com/en", fetchImpl),
    /resolved to host "evil\.example\.com"/,
  );
});

test("checkPath: a backslash-based path argument is rejected too -- a seventh review round found the WHATWG URL parser treats backslashes as slashes for https, so a purely lexical (string-shape) check missed this even though the round-6 fix already covered absolute and protocol-relative forms", async () => {
  const fetchImpl = async () => {
    throw new Error("fetchImpl should never be called -- the path should be rejected before any request is made");
  };
  for (const evilPath of ["\\\\evil.example.com\\en", "/\\evil.example.com/en"]) {
    await assert.rejects(
      () => checkPath("https://origin.example.com", "https://cdn.example.com", evilPath, fetchImpl),
      /resolved to host "evil\.example\.com"/,
    );
  }
});

test("checkPath: a genuine relative path (with or without a leading slash) is still allowed through unchanged", async () => {
  const fetchImpl = async (url) => fakeResponse({ url, headers: { "cache-control": "public, max-age=0" } });
  assert.equal(await checkPath("https://origin.example.com", "https://cdn.example.com", "/en", fetchImpl), true);
  assert.equal(await checkPath("https://origin.example.com", "https://cdn.example.com", "/hi?page=2", fetchImpl), true);
});

test("checkPath: constructs URLs by joining base + path correctly", async () => {
  let calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    return fakeResponse({ url, headers: { "cache-control": "public, max-age=0" } });
  };
  await checkPath("https://origin.example.com", "https://cdn.example.com", "/hi?page=2", fetchImpl);
  assert.deepEqual(
    calledUrls.sort(),
    ["https://cdn.example.com/hi?page=2", "https://origin.example.com/hi?page=2"].sort(),
  );
});

test("verify-cdn-headers.mjs: the direct-execution guard still runs main() when the script's own path needs URL escaping (e.g. contains a space) -- a ninth review round found the naive file://+argv comparison silently no-ops in that case, with no error at all. Importing the module (every other test in this file) never exercises this guard, so this test actually runs the script as a real subprocess.", () => {
  // realpathSync sidesteps a macOS-specific confound (/tmp is a symlink
  // to /private/tmp there) that would otherwise fail this test for an
  // unrelated reason -- reproduced and confirmed directly before writing
  // this test. On Linux (where CI actually runs) this is a no-op.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "verify cdn-")));
  try {
    mkdirSync(join(dir, "lib"), { recursive: true });
    copyFileSync(join(scriptsDir, "verify-cdn-headers.mjs"), join(dir, "verify-cdn-headers.mjs"));
    copyFileSync(join(scriptsDir, "lib", "cdn-header-check.mjs"), join(dir, "lib", "cdn-header-check.mjs"));

    const result = spawnSync(process.execPath, [join(dir, "verify-cdn-headers.mjs")], { encoding: "utf8" });

    // Before the fix, the broken guard meant main() never ran at all --
    // a silent exit 0 with no output whatsoever. After the fix, main()
    // runs, sees no CLI args, and prints its usage message with exit
    // code 2 -- reproduced both ways directly before writing this test.
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
