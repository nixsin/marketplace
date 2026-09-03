import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatShadowReport,
  shadowedVariables,
} from "./render-shadowed-env.mjs";
import { CONTRACTS } from "../../packages/config/src/env-contract.js";

test("a contract variable set directly on a service is reported", () => {
  // Render always prefers a service's own variable, so this one silently
  // wins over Terraform's and a rotation there does nothing.
  const findings = shadowedVariables(
    [
      { service: "medinstru-api", app: "api", names: ["JWT_SECRET", "SOME_OTHER"] },
      { service: "medinstru-web", app: "web", names: [] },
    ],
    CONTRACTS,
  );

  assert.deepEqual(findings, [
    { service: "medinstru-api", shadowed: ["JWT_SECRET"] },
  ]);
});

test("variables outside the contract are ignored", () => {
  // A service may legitimately carry its own operational variables. Only the
  // ones Terraform also sets are a conflict.
  const findings = shadowedVariables(
    [{ service: "medinstru-api", app: "api", names: ["RENDER_GIT_COMMIT", "PYTHONPATH"] }],
    CONTRACTS,
  );
  assert.deepEqual(findings, []);
});

test("a completed migration reports nothing", () => {
  assert.deepEqual(
    shadowedVariables([{ service: "medinstru-api", app: "api", names: [] }], CONTRACTS),
    [],
  );
  assert.match(formatShadowReport([]), /authoritative/);
});

test("the report names the service, the keys, and the fix", () => {
  // It is read by someone about to change a dashboard, so it has to say
  // which service and what to do — not just that something is wrong.
  const report = formatShadowReport([
    { service: "medinstru-api", shadowed: ["DATABASE_URL", "JWT_SECRET"] },
  ]);

  assert.match(report, /medinstru-api/);
  assert.match(report, /DATABASE_URL/);
  assert.match(report, /JWT_SECRET/);
  assert.match(report, /Render dashboard/);
  assert.match(report, /does nothing at all/);
});

test("a variable is judged against its own service's contract", () => {
  // JWT_SECRET is an API variable. Set on the WEB service it conflicts with
  // nothing, because the web group never sets it — reporting it would tell
  // an operator to delete unrelated configuration.
  const onWeb = shadowedVariables(
    [{ service: "medinstru-web", app: "web", names: ["JWT_SECRET"] }],
    CONTRACTS,
  );
  assert.deepEqual(onWeb, []);

  // The same name on the API service IS a conflict.
  const onApi = shadowedVariables(
    [{ service: "medinstru-api", app: "api", names: ["JWT_SECRET"] }],
    CONTRACTS,
  );
  assert.deepEqual(onApi, [
    { service: "medinstru-api", shadowed: ["JWT_SECRET"] },
  ]);

  // A name in BOTH contracts is a conflict on either service.
  const shared = "NEXT_PUBLIC_SITE_URL";
  for (const app of ["api", "web"]) {
    assert.equal(
      shadowedVariables(
        [{ service: `medinstru-${app}`, app, names: [shared] }],
        CONTRACTS,
      ).length,
      1,
      `${shared} must conflict on ${app}`,
    );
  }
});
