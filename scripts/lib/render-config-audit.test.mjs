import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configurationRows,
  environmentSeenBy,
  missingFromContract,
} from "./render-config-audit.mjs";

const group = (name, names, serviceIds) => ({ name, names, serviceIds });

test("a service sees its own variables plus every linked group", () => {
  // Reading one source answers a different question than the one asked: a
  // variable absent from the service list may be supplied by a group, or by
  // nobody, and those are opposite conclusions.
  const seen = environmentSeenBy({
    serviceId: "srv-api",
    directNames: async () => ["PORT", "JWT_SECRET"],
    groups: async () => [
      group("api-env", ["APP_ENV", "REDIS_URL"], ["srv-api"]),
      group("web-env", ["NEXT_PUBLIC_SITE_URL"], ["srv-web"]),
    ],
  });

  return seen.then(({ names, linked }) => {
    assert.deepEqual([...names].sort(), [
      "APP_ENV",
      "JWT_SECRET",
      "PORT",
      "REDIS_URL",
    ]);
    assert.deepEqual(linked, ["api-env"], "a group linked elsewhere is not ours");
  });
});

test("a group linked to no service contributes nothing", async () => {
  const { names, linked } = await environmentSeenBy({
    serviceId: "srv-api",
    directNames: async () => ["PORT"],
    groups: async () => [group("orphan", ["STRAY"], [])],
  });

  assert.deepEqual([...names], ["PORT"]);
  assert.deepEqual(linked, []);
});

test("missingFromContract names what the service will not receive", () => {
  const contract = [{ name: "PORT" }, { name: "APP_ENV" }, { name: "REDIS_URL" }];

  assert.deepEqual(missingFromContract(new Set(["PORT", "APP_ENV", "REDIS_URL"]), contract), []);
  assert.deepEqual(missingFromContract(new Set(["PORT"]), contract), ["APP_ENV", "REDIS_URL"]);
});

test("missing is a FAILURE and shadowing is a WARNING", () => {
  // They need different actions. Missing means the service cannot boot under
  // the startup contract; shadowing means it boots while Terraform decides
  // nothing. Collapsing them would either page someone about hygiene or bury
  // a boot-blocker inside a warning.
  const [coverage, ownership] = configurationRows({
    service: "medinstru-api",
    missing: ["APP_ENV"],
    shadowing: ["PORT", "JWT_SECRET"],
    linked: ["api-env"],
    required: 17,
  });

  assert.equal(coverage.status, "fail");
  assert.match(coverage.detail, /refuse to boot/);
  assert.match(coverage.detail, /APP_ENV/);

  assert.equal(ownership.status, "warn");
  assert.match(ownership.detail, /terraform apply reports success and changes nothing/);
  assert.match(ownership.detail, /PORT, JWT_SECRET/);
});

test("a clean service passes both rows and says where its values come from", () => {
  const [coverage, ownership] = configurationRows({
    service: "medinstru-web",
    missing: [],
    shadowing: [],
    linked: ["web-env"],
    required: 5,
  });

  assert.equal(coverage.status, "pass");
  assert.match(coverage.detail, /5\/5 present via web-env/);
  assert.equal(ownership.status, "pass");
});

test("a service with no groups still reports where its values came from", () => {
  // Not an error state — it is how every service looked before the groups
  // existed, and the row should say so rather than printing an empty list.
  const [coverage] = configurationRows({
    service: "medinstru-api",
    missing: [],
    shadowing: [],
    linked: [],
    required: 17,
  });

  assert.match(coverage.detail, /via service variables/);
});
