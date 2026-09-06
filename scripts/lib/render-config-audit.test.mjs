import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configurationRows,
  environmentSeenBy,
  fetchAllPages,
  loadEnvGroups,
  missingFromContract,
} from "./render-config-audit.mjs";

const group = (name, names, serviceIds) => ({ name, names, serviceIds });

test("a service sees its own variables plus every linked group", async () => {
  // Reading one source answers a different question than the one asked: a
  // variable absent from the service list may be supplied by a group, or by
  // nobody, and those are opposite conclusions.
  const { names, linked } = await environmentSeenBy({
    serviceId: "srv-api",
    directNames: async () => ["PORT", "JWT_SECRET"],
    groups: async () => [
      group("api-env", ["APP_ENV", "REDIS_URL"], ["srv-api"]),
      group("web-env", ["NEXT_PUBLIC_SITE_URL"], ["srv-web"]),
    ],
  });

  assert.deepEqual([...names].sort(), [
    "APP_ENV",
    "JWT_SECRET",
    "PORT",
    "REDIS_URL",
  ]);
  assert.deepEqual(linked, ["api-env"], "a group linked elsewhere is not ours");
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

test("every page is read, not just the first hundred", async () => {
  // `?limit=100` with no pagination truncates silently, and that breaks BOTH
  // directions: linked groups past page one look absent, so their variables
  // read as missing; service overrides past it read as "nothing shadows".
  const pages = {
    undefined: [{ key: "A" }, { key: "B", cursor: "c1" }],
    c1: [{ key: "C" }, { key: "D", cursor: "c2" }],
    c2: [{ key: "E" }],
  };
  const items = await fetchAllPages((cursor) => Promise.resolve(pages[String(cursor)]));

  assert.deepEqual(items.map((i) => i.key), ["A", "B", "C", "D", "E"]);
});

test("a repeated cursor is a stall, not completion", async () => {
  // Treating it as done reports on a partial list; treating it as a normal
  // page runs forever.
  await assert.rejects(
    fetchAllPages(() => Promise.resolve([{ key: "A", cursor: "same" }])),
    /Pagination looped/,
  );
});

test("a response that is not a list is refused, not read as empty", async () => {
  await assert.rejects(
    fetchAllPages(() => Promise.resolve({ envVars: [] })),
    /not a list/,
  );
});

test("an unreadable group is reported as unreadable, never as empty", async () => {
  // Swallowing the failure makes that group's variables read as missing from
  // every service linked to it — a boot-failure finding drawn from data
  // nobody has.
  const { groups, unreadable } = await loadEnvGroups({
    listPage: () =>
      Promise.resolve([
        { id: "g1", name: "api-env", envVars: [{ key: "APP_ENV" }], serviceLinks: [{ id: "srv-api" }] },
        { id: "g2", name: "cache-env", serviceLinks: [{ id: "srv-api" }] },
      ]),
    detail: (id) => {
      if (id === "g2") return Promise.reject(new Error("403 forbidden"));
      return Promise.resolve({ envVars: [] });
    },
  });

  assert.deepEqual(groups.map((g) => g.name), ["api-env"]);
  assert.deepEqual(unreadable, [{ name: "cache-env", error: "403 forbidden" }]);
});

test("a group whose list entry omits envVars is fetched in detail", async () => {
  // Some plans omit envVars from the list endpoint, so an empty list there is
  // not evidence the group is empty.
  const { groups, unreadable } = await loadEnvGroups({
    listPage: () =>
      Promise.resolve([{ id: "g1", name: "api-env", serviceLinks: [{ id: "srv-api" }] }]),
    detail: () => Promise.resolve({ envVars: [{ key: "REDIS_URL" }, { key: "APP_ENV" }] }),
  });

  assert.deepEqual(groups[0].names, ["REDIS_URL", "APP_ENV"]);
  assert.deepEqual(groups[0].serviceIds, ["srv-api"]);
  assert.deepEqual(unreadable, []);
});

test("groups are read across pages too", async () => {
  const pages = {
    undefined: [{ id: "g1", name: "one", envVars: [{ key: "A" }], serviceLinks: [], cursor: "c1" }],
    c1: [{ id: "g2", name: "two", envVars: [{ key: "B" }], serviceLinks: [] }],
  };
  const { groups } = await loadEnvGroups({
    listPage: (cursor) => Promise.resolve(pages[String(cursor)]),
    detail: () => Promise.reject(new Error("should not be called")),
  });

  assert.deepEqual(groups.map((g) => g.name), ["one", "two"]);
});
