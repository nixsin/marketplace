import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = path.resolve("scripts/cloudflare-terraform-ids.sh");

const mockCurl = String.raw`#!/usr/bin/env node
if (process.env.CLOUDFLARE_API_TOKEN) {
  process.stderr.write("token leaked into curl environment");
  process.exit(3);
}
const url = process.argv.at(-1);
const scenario = process.env.MOCK_SCENARIO;
const zone = { id: "zone-1", name: "laxair.shop" };
const dnsName = new URL(url).searchParams.get("name");

let body;
if (url.includes("/zones?")) {
  body = { result: scenario === "duplicate-zone" ? [zone, { ...zone, id: "zone-2" }] : [zone] };
} else if (url.includes("/dns_records?")) {
  const records = [{ id: "record-" + dnsName, name: dnsName, type: "CNAME" }];
  body = { result: scenario === "duplicate-record" && dnsName === "api.laxair.shop" ? [...records, { ...records[0], id: "duplicate" }] : records };
} else if (/\/rulesets\/cache-1$/.test(url)) {
  body = scenario === "ruleset-api-error"
    ? { success: false, result: null, errors: [{ message: "denied" }] }
    : { result: { rules: [{ id: "rule-1" }, { id: "rule-2" }] } };
} else if (url.includes("/rulesets?")) {
  const page = Number(new URL(url).searchParams.get("page"));
  if (scenario === "not-created") body = { result: [], result_info: { total_pages: 1 } };
  else if (page === 1) body = { result: [{ id: "other", kind: "zone", phase: "http_request_firewall_custom" }], result_info: { total_pages: 2 } };
  else body = { result: [{ id: "cache-1", kind: "zone", phase: "http_request_cache_settings" }], result_info: { total_pages: 2 } };
} else {
  process.stderr.write("unexpected URL: " + url);
  process.exit(2);
}
if (!("success" in body)) body.success = true;
process.stdout.write(JSON.stringify(body));
`;

async function run(scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), "cloudflare-ids-"));
  try {
    const curl = path.join(directory, "curl");
    await writeFile(curl, mockCurl);
    await chmod(curl, 0o755);
    return spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "test-token",
        MOCK_SCENARIO: scenario,
        PATH: `${directory}:${process.env.PATH}`,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("finds a cache ruleset on a later page and reports its rule count", async () => {
  const result = await run("multi-page");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zone_id=zone-1/);
  assert.match(result.stdout, /cache_ruleset_id=cache-1/);
  assert.match(result.stdout, /cache_ruleset_rule_count=2/);
  assert.match(result.stdout, /cache_ruleset_rules_json=\[{"id":"rule-1"},{"id":"rule-2"}\]/);
});

test("reports when no cache-settings ruleset exists", async () => {
  const result = await run("not-created");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cache_ruleset_id=not-created/);
  assert.doesNotMatch(result.stdout, /cache_ruleset_rule_count=/);
  assert.doesNotMatch(result.stdout, /cache_ruleset_rules_json=/);
});

test("fails closed when zone lookup is ambiguous", async () => {
  const result = await run("duplicate-zone");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected exactly one zone/);
});

test("fails closed when an exact DNS record lookup is ambiguous", async () => {
  const result = await run("duplicate-record");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected exactly one CNAME/);
});

test("fails closed on an HTTP-200 Cloudflare API error", async () => {
  const result = await run("ruleset-api-error");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /success=false or a null result/);
  assert.doesNotMatch(result.stdout, /cache_ruleset_rule_count=/);
});
