import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  mask,
  report,
  requirements,
  sensitiveVariables,
  terraformRequirements,
  toolingRequirements,
} from "./check-local-env.mjs";

test("a value is never shown, at any length", () => {
  // The property that matters most here, and the one this script got wrong
  // on its first run: it borrowed a helper that sanitises rather than masks
  // and printed three live credentials to the terminal.
  // Assembled rather than written out: a credential-shaped literal trips
  // scripts/lib/repo-hygiene.test.mjs, which scans tracked files for
  // committed secrets. It caught this fixture, correctly.
  const secret = ["sk", "proj", "notarealkey"].join("-") + "0".repeat(5);
  const [result] = evaluate([{ name: "K" }], { K: secret });

  assert.equal(result.shown, `*** (${secret.length} chars)`);
  assert.ok(!result.shown.includes("sk-proj"), "the prefix identifies the service");
  assert.ok(!result.shown.includes("abcdef"), "no content may appear");

  // Including the degenerate cases, where "show a little" is most tempting.
  assert.equal(mask("a"), "*** (1 chars)");
  assert.equal(mask("x".repeat(500)), "*** (500 chars)");
});

test("absent and empty are different states", () => {
  // `export FOO=` is a decision; an unset FOO is an oversight -- the same
  // distinction the startup contract draws. So absent always fails, and
  // empty passes only where the variable documents what empty means.
  const wanted = [
    { name: "A", emptyMeans: "feature off" },
    { name: "B", emptyMeans: "feature off" },
    { name: "C", emptyMeans: null },
  ];
  const [absent, empty, emptyNotAllowed] = evaluate(wanted, { B: "   ", C: "" });

  assert.equal(absent.state, "absent");
  assert.equal(absent.ok, false, "an unset variable is always a problem");

  assert.equal(empty.state, "empty");
  assert.equal(empty.ok, true, "empty is a decision where one is documented");
  assert.equal(empty.shown, null, "an empty value has nothing to show either");

  assert.equal(emptyNotAllowed.ok, false, "empty is not allowed without a meaning");
});

test("only sensitive variables are asked of the shell", () => {
  // Everything else has a default or lives in a committed tfvars, so asking
  // for it would be noise a developer learns to ignore.
  const variables = `
variable "region" {
  type    = string
  default = "singapore"
}

variable "whatsapp_access_token" {
  type      = string
  sensitive = true
  default   = ""
}
`;
  const wanted = terraformRequirements([{ stack: "render", variables }]);

  assert.deepEqual(wanted.map((w) => w.name), ["TF_VAR_whatsapp_access_token"]);
  assert.match(wanted[0].breaks, /silently off/);
});

test("sensitive is attributed to the variable it belongs to", () => {
  // The one association HCL makes unambiguous, and all this needs. No brace
  // counting: every attempt at that produced a false NEGATIVE that dropped a
  // variable while the script still exited 0.
  const found = sensitiveVariables(`
variable "plain" {
  type = string
}

variable "secret_one" {
  type      = string
  sensitive = true
}

variable "shaped" {
  type = object({
    default = string
  })
}

  variable "indented_secret" {
    sensitive = true
  }
`);
  assert.deepEqual(found, ["secret_one", "indented_secret"]);
});

test("a one-line SENSITIVE block is not dropped", () => {
  // The attributes are on the header line, so reading only later lines
  // misses them — a false negative that omits a credential entirely while
  // the script still exits 0. An earlier version of this test used a
  // one-line NON-sensitive variable and so never exercised the case.
  assert.deepEqual(
    sensitiveVariables('variable "inline_secret" { sensitive = true }\n'),
    ["inline_secret"],
  );

  // Mixed with the multiline form, and a one-liner that is not sensitive.
  assert.deepEqual(
    sensitiveVariables(
      [
        'variable "plain" { type = string }',
        'variable "inline_secret" { type = string, sensitive = true }',
        'variable "multiline_secret" {',
        "  sensitive = true",
        "}",
      ].join("\n"),
    ),
    ["inline_secret", "multiline_secret"],
  );
});

test("tooling keys are derived from AI_ROLES, one entry per key", () => {
  // Four roles share two keys. Asking for the same key four times would
  // make the report unreadable and imply four things to set.
  const wanted = toolingRequirements({
    a: { apiKeyEnv: "OPENAI_API_KEY" },
    b: { apiKeyEnv: "OPENAI_API_KEY" },
    c: { apiKeyEnv: "ANTHROPIC_API_KEY" },
    d: { model: "no key at all" },
  });

  assert.deepEqual(wanted.map((w) => w.name), [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]);
  assert.match(wanted[0].why, /a, b/, "names the roles that need it");

  // CLAUDE.md is emphatic that a silently-skipped precheck is the failure
  // mode to avoid, so this one has no legitimate empty state.
  assert.equal(wanted[0].emptyMeans, null, "OPENAI_API_KEY may not be empty");
  assert.ok(wanted[1].emptyMeans, "the other automation may be declined");
});

test("the real repo produces a usable list", () => {
  // Guards the wiring rather than the contents: a broken path or a renamed
  // export would otherwise yield an empty list that passes every check.
  const wanted = requirements();
  const names = wanted.map((w) => w.name);

  assert.ok(names.includes("OPENAI_API_KEY"), "AI roles were not read");
  assert.ok(names.includes("TF_VAR_jwt_secret"), "terraform was not read");
  assert.ok(names.includes("RENDER_API_KEY"), "provider credentials missing");
  assert.equal(new Set(names).size, names.length, "no name is asked for twice");
});

test("the report never contains a value, whatever the state", () => {
  const secret = ["rnd", "notarealtoken"].join("_");
  const text = report(
    evaluate(
      [
        { name: "A", why: "w", breaks: "b", emptyMeans: null },
        { name: "B", why: "w", breaks: "b", emptyMeans: "off" },
      ],
      { A: secret, B: "" },
    ),
  );

  assert.ok(!text.includes(secret), "the report leaked a credential");
  assert.match(text, new RegExp(`\\*\\*\\* \\(${secret.length} chars\\)`));
});

test("a heredoc description cannot retarget the sensitive association", () => {
  // Reachable, not hypothetical: every `description` in render/variables.tf
  // is a heredoc, and their content is free prose. A sentence mentioning
  // another variable would otherwise attach the `sensitive` below it to the
  // wrong name — dropping the real credential from the report entirely.
  const found = sensitiveVariables(`
variable "real_secret" {
  description = <<-EOT
    See variable "decoy" for the shape of this.
    variable "another_decoy" {
  EOT
  sensitive = true
}
`);
  // The real credential is what must never be lost. A decoy name may also
  // appear -- the union over-reports on purpose, and an extra
  // `export TF_VAR_decoy=` is visible and cheap, where a dropped credential
  // is silent.
  assert.ok(found.includes("real_secret"));
});

test("a block comment cannot retarget it either", () => {
  const found = sensitiveVariables(`
variable "real_secret" {
/*
variable "decoy" {
*/
  sensitive = true
}
`);
  assert.ok(found.includes("real_secret"));
});

test("PRECHECK_OPTOUT declines the key it documents", () => {
  // The comment claimed this was the deliberate way to decline the precheck
  // while the checker failed regardless, which made the advice untrue.
  const [wanted] = toolingRequirements({ r: { apiKeyEnv: "OPENAI_API_KEY" } });

  const [without] = evaluate([wanted], {});
  assert.equal(without.ok, false, "unset and no opt-out is still a problem");

  const [declined] = evaluate([wanted], { PRECHECK_OPTOUT: "1" });
  assert.equal(declined.ok, true, "the documented opt-out must satisfy it");
  assert.equal(declined.declined, true);
});

test("a missing variables.tf fails loudly instead of dropping a stack", () => {
  // Silently skipping would drop every credential that stack needs while
  // the check still reported success.
  assert.throws(
    () => requirements({ root: "/nonexistent-repo-root" }),
    /not found/,
  );
});

test("root is joined as a path, with or without a trailing slash", () => {
  // `root + "infra/..."` produced /tmp/repoinfra/... for any conventional
  // path; only the default, which came from a directory URL, happened to work.
  const message = (root) => {
    try {
      requirements({ root });
      return "";
    } catch (error) {
      return error.message;
    }
  };
  assert.match(message("/nonexistent-repo-root"), /\/nonexistent-repo-root\/infra\//);
  assert.match(message("/nonexistent-repo-root/"), /\/nonexistent-repo-root\/infra\//);
});

test("a comment that merely looks like a heredoc cannot hide later variables", () => {
  // Derails the SKIPPING pass: it treats `<<EOT` in a comment as a real
  // opener and swallows everything after it. The reading pass is unaffected,
  // and the union keeps the credential.
  const found = sensitiveVariables(`
# for example: <<EOT
variable "after_the_decoy" {
  sensitive = true
}
`);
  assert.ok(
    found.includes("after_the_decoy"),
    "a comment must not be able to hide a credential",
  );
});

test("code and a comment on the same line still register", () => {
  // Derails the skipping pass differently: the line carries a real
  // declaration AND a comment opener.
  const found = sensitiveVariables(`
variable "mixed" { /* note */
  sensitive = true
}
`);
  assert.ok(found.includes("mixed"));
});

test("the union can only add names, never lose one", () => {
  // The property the whole construction exists for. Both derailments in one
  // file: each pass loses a different variable, the union loses neither.
  const found = sensitiveVariables(`
# looks like an opener: <<EOT
variable "hidden_from_skipping_pass" {
  sensitive = true
}

variable "hidden_from_reading_pass" {
  description = <<-EOT
    see variable "decoy"
  EOT
  sensitive = true
}
`);
  assert.ok(found.includes("hidden_from_skipping_pass"));
  assert.ok(found.includes("hidden_from_reading_pass"));
});

test("a declined requirement is not rendered as a failure", () => {
  // The report used to print ✗ (NOT SET) directly above "every variable is
  // declared" — internally contradictory, which is how a report stops being
  // read at all.
  const [wanted] = toolingRequirements({ r: { apiKeyEnv: "OPENAI_API_KEY" } });
  const text = report(evaluate([wanted], { PRECHECK_OPTOUT: "1" }));

  assert.ok(!text.includes("NOT SET"), "a declined key is not missing");
  assert.match(text, /declined via PRECHECK_OPTOUT/);
  assert.match(text, /every variable is declared/);
});

test("an empty-and-declined key is not listed as deliberately empty", () => {
  // It has no emptyMeans at all, so that section rendered
  // "OPENAI_API_KEY — null." It is satisfied by the opt-out, not by being
  // empty.
  const [wanted] = toolingRequirements({ r: { apiKeyEnv: "OPENAI_API_KEY" } });
  const text = report(
    evaluate([wanted], { OPENAI_API_KEY: "", PRECHECK_OPTOUT: "1" }),
  );

  assert.ok(!text.includes("null"), "rendered a null reason");
  assert.ok(!text.includes("Deliberately empty"), "it is declined, not empty");
  assert.match(text, /declined via PRECHECK_OPTOUT/);
});

test("the opt-out matches the hook it describes, not a narrower rule", () => {
  // scripts/ai-code-review-precheck.mjs uses `if (process.env.PRECHECK_OPTOUT)`
  // — any non-empty value. Accepting only "1" here would make this checker
  // and the hook disagree about whether the precheck is opted out.
  const [wanted] = toolingRequirements({ r: { apiKeyEnv: "OPENAI_API_KEY" } });
  for (const value of ["1", "true", "yes", "0"]) {
    assert.equal(
      evaluate([wanted], { PRECHECK_OPTOUT: value })[0].ok,
      true,
      `PRECHECK_OPTOUT=${value} silences the hook, so it must satisfy this too`,
    );
  }
  assert.equal(evaluate([wanted], { PRECHECK_OPTOUT: "" })[0].ok, false);
});

test("a heredoc-looking comment no longer derails the skipping pass", () => {
  const found = sensitiveVariables(`
# for example: <<EOT
variable "after_comment" {
  sensitive = true
}
`);
  assert.ok(found.includes("after_comment"));
});

test("a block comment sharing a line with a declaration is seen through", () => {
  // Invisible to both passes before this: the skipping pass does not enter
  // comment mode because the line also closes it, and the reading pass's
  // anchored regex cannot match through the leading comment. A silent miss —
  // the direction the union exists to rule out.
  assert.deepEqual(
    sensitiveVariables('/* note */ variable "secret" {\n  sensitive = true\n}\n'),
    ["secret"],
  );

  // And a comment after the header, on the same line.
  assert.deepEqual(
    sensitiveVariables('variable "other" { /* x */\n  sensitive = true\n}\n'),
    ["other"],
  );
});
