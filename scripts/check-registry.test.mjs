import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * The CLI itself, spawned for real, against a real HTTP server.
 *
 * lib/check-registry.test.mjs covers the decision through a fetch double;
 * this covers the process boundary — and above all the EXIT STATUS, which
 * is the only part the workflow actually consumes. The same split, and the
 * same reason, as check-outdated.test.mjs beside it: a library that returns
 * the right object and a CLI that exits 0 anyway would pass every test in
 * that file while letting `pnpm outdated` run against a dead registry.
 *
 * A real server rather than a mock, because a spawned process cannot be
 * handed a fetch double — and the thing under test here is precisely what
 * happens when the two are wired together for real.
 */
const CLI = fileURLToPath(new URL("./check-registry.mjs", import.meta.url));

/** Starts a throwaway HTTP server, returning its origin and a stop(). */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs the CLI, returning status and combined output rather than throwing.
 *
 * ASYNC, and that is load-bearing rather than stylistic: the test server
 * above runs in THIS process, so a blocking `execFileSync` holds the event
 * loop and the server never accepts the child's connection. Every
 * server-backed case then fails on the CLI's own 15s timeout, which reads
 * exactly like a broken probe rather than a deadlocked harness.
 */
const execFileAsync = promisify(execFile);

async function run(registry) {
  const args = [CLI, ...(registry === undefined ? [] : [registry])];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { encoding: "utf8" });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.code, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("exits 0 when the registry serves the package document", async () => {
  const { origin, stop } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "semver", versions: {} }));
  });
  try {
    const { status, output } = await run(`${origin}/`);
    assert.equal(status, 0);
    assert.match(output, /served package metadata/);
  } finally {
    await stop();
  }
});

test("exits 2 — never 1 — when the registry is unreachable", async () => {
  // 1 means "an actionable major was found". Reporting an outage with it
  // would send someone looking for an upgrade that does not exist.
  const { status, output } = await run("http://127.0.0.1:1/");
  assert.equal(status, 2);
  assert.match(output, /refusing to report dependency freshness/);
});

test("exits 2 on a 200 that is not the package document", async () => {
  // A captive portal or login page answers 200. The shell version this
  // replaced discarded the body and accepted every one of them.
  const { origin, stop } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>Sign in</body></html>");
  });
  try {
    const { status, output } = await run(`${origin}/`);
    assert.equal(status, 2);
    assert.match(output, /did not return semver metadata/);
  } finally {
    await stop();
  }
});

test("probes the CONFIGURED PATH, not the origin", async () => {
  // An Artifactory or Verdaccio under a path has a root that can answer
  // while the configured registry is down. Asserted by serving the package
  // ONLY under the path and 404ing everything else -- so an origin-probing
  // implementation fails this test rather than passing it by luck.
  const seen = [];
  const { origin, stop } = await serve((req, res) => {
    seen.push(req.url);
    if (req.url === "/api/npm/npm-remote/semver") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "semver" }));
      return;
    }
    res.writeHead(404).end("nope");
  });
  try {
    const { status } = await run(`${origin}/api/npm/npm-remote/`);
    assert.equal(status, 0);
    assert.deepEqual(seen, ["/api/npm/npm-remote/semver"]);
  } finally {
    await stop();
  }
});

test("exits 2 when no registry is given at all", async () => {
  // How a failing `pnpm config get registry` reaches the CLI: the workflow
  // passes whatever it got, including nothing.
  for (const registry of ["", undefined]) {
    const { status, output } = await run(registry);
    assert.equal(status, 2, `expected 2 for ${JSON.stringify(registry)}`);
    assert.match(output, /no usable registry/);
  }
});

test("never prints the credential from a registry URL", async () => {
  // This output goes into a public workflow log.
  const { status, output } = await run("http://user:hunter2@127.0.0.1:1/");
  assert.equal(status, 2);
  assert.doesNotMatch(output, /hunter2|user:/);
  assert.match(output, /127\.0\.0\.1:1/);
});
