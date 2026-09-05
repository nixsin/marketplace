import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_TOOLS,
  STACK_TOOLS,
  candidateBinDirs,
  checkNode,
  checkTools,
  corepackState,
  evaluate,
  freshShellTools,
  installedNodeVersions,
  locateOffPath,
  mask,
  nonInteractiveTools,
  parseVersion,
  pinnedPnpmVersion,
  probeVersion,
  proposeFixes,
  report,
  reportShellGaps,
  reportTools,
  requirements,
  satisfiesFloor,
  sensitiveVariables,
  shellGaps,
  shellQuote,
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

test("a tool missing from PATH is a failure, not a warning", () => {
  // There is no "declare it empty" equivalent for a tool: you either have
  // psql or you cannot follow the recovery steps it is needed for.
  const absent = () => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  };
  assert.equal(probeVersion("nope", absent), null);

  const [checked] = checkTools([{ name: "nope", why: "x" }], { run: absent });
  assert.equal(checked.present, false);
  assert.equal(checked.ok, false);
  assert.equal(checked.version, null);
});

test("a version that violates what the repo declares FAILS", () => {
  // Was a note once, on the reasoning that corepack reconciles pnpm anyway.
  // A check that reports a wrong version and exits 0 is one people stop
  // reading, and the wrong version is what produces a confusing failure
  // three steps later.
  const [mismatch] = checkTools([{ name: "pnpm", why: "x", floor: { kind: "exact", from: "packageManager" } }], {
    run: () => "11.25.0\n",
    declared: { pnpm: "11.21.0" },
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.problem, /exactly 11\.21\.0/);

  const [matching] = checkTools([{ name: "pnpm", why: "x", floor: { kind: "exact", from: "packageManager" } }], {
    run: () => "11.21.0\n",
    declared: { pnpm: "11.21.0" },
  });
  assert.equal(matching.ok, true);
  assert.equal(matching.problem, null);
});

test("each floor kind compares the way its source means", () => {
  //   min     a declared `>=` range   (terraform's required_version)
  //   exact   a pin                   (packageManager)
  //   major   a client/server pairing (the postgres image tag)
  assert.equal(satisfiesFloor("Terraform v1.15.8", { kind: "min", value: ">= 1.9.0" }), true);
  assert.equal(satisfiesFloor("Terraform v1.8.0", { kind: "min", value: ">= 1.9.0" }), false);

  assert.equal(satisfiesFloor("psql (PostgreSQL) 16.15", { kind: "major", value: "16" }), true);
  assert.equal(satisfiesFloor("psql (PostgreSQL) 15.4", { kind: "major", value: "16" }), false);

  assert.equal(satisfiesFloor("11.21.0", { kind: "exact", value: "11.21.0" }), true);
  assert.equal(satisfiesFloor("11.21.1", { kind: "exact", value: "11.21.0" }), false);
});

test("versions are read out of each tool's own wording", () => {
  // They all phrase it differently, and a parser that only handled one of
  // them would silently compare nothing.
  assert.deepEqual(parseVersion("Terraform v1.15.8"), [1, 15, 8]);
  assert.deepEqual(parseVersion("git version 2.50.1 (Apple Git-155)"), [2, 50, 1]);
  assert.deepEqual(parseVersion("psql (PostgreSQL) 16.15 (Homebrew)"), [16, 15, 0]);
  assert.deepEqual(parseVersion("Docker version 29.7.2, build a7dcaa"), [29, 7, 2]);
  assert.deepEqual(parseVersion("11.21.0"), [11, 21, 0]);
  assert.equal(parseVersion("no digits here"), null);
});

test("a floor that is only a major still compares", () => {
  // The postgres image tag is `16`, with no dots. Requiring a dot made this
  // parse to null, which satisfiesFloor reads as "cannot judge" and passes —
  // so a psql 15 client against a 16 server went unreported.
  assert.deepEqual(parseVersion("16"), [16, 0, 0]);
  assert.equal(satisfiesFloor("psql (PostgreSQL) 15.4", { kind: "major", value: "16" }), false);
});

test("a tool with no declared requirement is not held to an invented one", () => {
  // docker, git and gh have no version declared anywhere in the repo.
  // Enforcing a number nobody chose turns a green check into an argument.
  for (const name of ["docker", "git", "gh"]) {
    const tool = REQUIRED_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} should be checked for presence`);
    assert.equal(tool.floor, undefined, `${name} must not carry a floor`);
  }
});

test("node is checked against engines, and is not in REQUIRED_TOOLS", () => {
  assert.equal(checkNode(">=22.0.0", "v22.23.2").ok, true);
  assert.equal(checkNode(">=22.0.0", "v20.11.0").ok, false);
  assert.match(checkNode(">=22.0.0", "v20.11.0").problem, /engines/);

  // It cannot be in REQUIRED_TOOLS: this is a node script, so a machine
  // without node never reaches the check. The .sh wrapper covers that.
  assert.ok(!REQUIRED_TOOLS.some((t) => t.name === "node"));
});

test("node is deliberately not among the checked tools", () => {
  // It cannot be. This is a node script, so a machine without node never
  // reaches the check at all — scripts/check-local-env.sh covers it, and
  // listing node here would imply a guarantee this file cannot give.
  assert.ok(
    !REQUIRED_TOOLS.some((t) => t.name === "node"),
    "node belongs in the shell bootstrap, not here",
  );
});

test("the pnpm pin is read from packageManager", () => {
  assert.equal(pinnedPnpmVersion({ packageManager: "pnpm@11.21.0" }), "11.21.0");
  assert.equal(pinnedPnpmVersion({ packageManager: "yarn@4.0.0" }), null);
  assert.equal(pinnedPnpmVersion({}), null);
});

test("a tool present here but not in a fresh shell is reported, not failed", () => {
  // Everything works in the shell running this, so failing would block work
  // that is about to succeed. It is a warning about the NEXT terminal.
  const tools = [
    { name: "node", ok: true, present: true },
    { name: "docker", ok: true, present: true },
  ];
  const fresh = [
    { name: "node", resolves: false },
    { name: "docker", resolves: true },
  ];
  assert.deepEqual(shellGaps(tools, fresh), ["node"]);

  // Unknown shell, or a probe that failed: no claim either way.
  assert.deepEqual(shellGaps(tools, null), []);
  assert.equal(freshShellTools(["node"], { shell: "/usr/bin/fish" }), null);
  assert.equal(
    freshShellTools(["node"], {
      shell: "/bin/zsh",
      run: () => {
        throw new Error("spawn failed");
      },
    }),
    null,
  );
});

test("the fresh-shell probe explains the nvm cause it exists for", () => {
  const text = reportShellGaps(["node"]);
  assert.match(text, /a new terminal would not find these/);
  assert.match(text, /nvm alias default/);
  assert.match(text, /~\/\.zshenv/, "PATH advice differs from the secrets advice");
  assert.equal(reportShellGaps([]), "", "nothing to say when there are no gaps");
});

test("the tool report names what is missing and how to install it", () => {
  const text = reportTools([
    { name: "terraform", why: "infra", present: false, ok: false, version: null, note: null },
    { name: "git", why: "workflow", present: true, ok: true, version: "2.50.1", note: null },
  ]);

  // Not-installed and installed-but-off-PATH read differently, because they
  // need opposite fixes and conflating them tells someone to install
  // software they already have.
  assert.match(text, /NOT INSTALLED/);
  assert.match(text, /terraform — infra/);
  // Points at `--fix`, which THIS change implements. The previous change
  // deliberately did not mention it, because advertising a flag the build
  // ignores is worse than saying nothing.
  assert.match(text, /--fix/);
});

test("installed-but-off-PATH is reported as such, not as missing", () => {
  const text = reportTools([
    { name: "psql", why: "recovery", present: false, ok: false, version: null,
      foundAt: "/opt/homebrew/opt/postgresql@16/bin",
      problem: "installed at /opt/homebrew/opt/postgresql@16/bin, but not on PATH." },
  ]);
  assert.match(text, /INSTALLED, NOT ON PATH/);
  assert.ok(!text.includes("NOT INSTALLED"), "it is installed");
});

test("candidateBinDirs knows the keg-only postgres location", () => {
  // Homebrew does not link postgresql@N into bin, which is why CLAUDE.md's
  // recovery steps spell the path out in full. The major follows the compose
  // image rather than being written twice.
  const dirs = candidateBinDirs("psql", {
    home: "/Users/x", brewPrefix: "/opt/homebrew", postgresMajor: "16",
  });
  assert.ok(dirs.includes("/opt/homebrew/opt/postgresql@16/bin"));

  const found = locateOffPath("psql", dirs, (p) =>
    p === "/opt/homebrew/opt/postgresql@16/bin/psql");
  assert.equal(found, "/opt/homebrew/opt/postgresql@16/bin");
  assert.equal(locateOffPath("psql", dirs, () => false), null);
});

test("a probe whose every lookup fails reports all missing, not 'unknown'", () => {
  // The shell exits with the status of its LAST command, so a script whose
  // final `command -v` finds nothing exits non-zero and the spawn throws.
  // The catch then reported "cannot introspect" for the one case that matters
  // most — everything missing — which is exactly the state this machine was
  // in when the probe was written.
  assert.deepEqual(
    freshShellTools(["node", "pnpm"], { shell: "/bin/zsh", run: () => "" }),
    [
      { name: "node", resolves: false },
      { name: "pnpm", resolves: false },
    ],
  );
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

  assert.deepEqual(
    sensitiveVariables('variable "other" { /* x */\n  sensitive = true\n}\n'),
    ["other"],
  );
});

test("only stack-essential tools are allowed to block the dev stack", () => {
  // terraform, psql and gh are for infrastructure, database recovery and PR
  // workflows — none of which is starting Postgres. Blocking ./scripts/dev.sh
  // on them stops someone with node, pnpm and docker from working for an
  // unrelated reason, which is how a preflight gets commented out.
  assert.deepEqual(STACK_TOOLS, ["node", "pnpm", "docker"]);

  for (const name of ["terraform", "psql", "gh"]) {
    assert.ok(
      REQUIRED_TOOLS.some((t) => t.name === name),
      `${name} must still be CHECKED`,
    );
    assert.ok(
      !STACK_TOOLS.includes(name),
      `${name} must not gate the dev stack`,
    );
  }
});

test("nvm candidates point at a version's bin, not the versions directory", () => {
  // It pushed `~/.nvm/versions/node`, so locateOffPath looked for
  // `~/.nvm/versions/node/node` — a path that never exists. An nvm-installed
  // node was therefore reported "not installed" rather than "off PATH", and
  // the repair offered would have been `brew install node`.
  const dirs = candidateBinDirs("node", {
    home: "/Users/x",
    brewPrefix: "/opt/homebrew",
    nodeVersions: ["v22.23.2", "v24.19.0"],
  });

  assert.ok(dirs.includes("/Users/x/.nvm/versions/node/v22.23.2/bin"));
  assert.ok(!dirs.includes("/Users/x/.nvm/versions/node"), "the bare dir holds no binary");

  assert.equal(
    locateOffPath("node", dirs, (p) => p === "/Users/x/.nvm/versions/node/v24.19.0/bin/node"),
    "/Users/x/.nvm/versions/node/v24.19.0/bin",
  );

  // No nvm at all: only the Homebrew candidate remains.
  assert.deepEqual(
    candidateBinDirs("node", { home: "/Users/x", brewPrefix: "/opt/homebrew" }),
    ["/opt/homebrew/bin"],
  );
});


test("a fix never invents a credential", () => {
  // The hard line. A generated secret looks configured, works locally, and is
  // wrong everywhere else — worse than the missing value it replaced.
  const variables = [
    { name: "TF_VAR_jwt_secret", ok: false, emptyMeans: null, why: "w", breaks: "b" },
    { name: "OPENAI_API_KEY", ok: false, emptyMeans: null, why: "w", breaks: "b" },
  ];
  const fixes = proposeFixes({ variables });

  assert.equal(fixes.length, 2);
  for (const fix of fixes) {
    assert.equal(fix.manual, true, `${fix.title} must not be automated`);
    assert.equal(fix.command, undefined);
    assert.equal(fix.appendToRc, undefined);
  }
});

test("a variable whose empty is documented can be recorded automatically", () => {
  // Safe because it writes a DECISION, not a value.
  const [fix] = proposeFixes({
    variables: [
      {
        name: "TF_VAR_whatsapp_access_token",
        ok: false,
        emptyMeans: "delivery is off",
        why: "w",
        breaks: "b",
      },
    ],
  });

  assert.equal(fix.manual, undefined);
  assert.match(fix.appendToRc, /^export TF_VAR_whatsapp_access_token=/);
  assert.match(fix.appendToRc, /delivery is off/, "the reason goes on record");
  assert.ok(!/=\S/.test(fix.appendToRc.split("#")[0]), "must assign nothing");
});

test("the nvm fix prefers the major CI runs, not the newest installed", () => {
  // Newest is the obvious pick and the wrong one: it puts local development
  // on a Node that CI never exercises.
  const [fix] = proposeFixes({
    gaps: ["node"],
    declared: { node: ">=22.0.0", ciNode: "22" },
    installedNode: ["v22.23.2", "v24.19.0"],
  });
  assert.equal(fix.command, "nvm alias default 22");
  assert.equal(fix.shell, true, "nvm is a shell function, not a binary");

  // Falls back to newest-satisfying when CI's major is not installed.
  const [fallback] = proposeFixes({
    gaps: ["node"],
    declared: { node: ">=22.0.0", ciNode: "22" },
    installedNode: ["v24.19.0"],
  });
  assert.equal(fallback.command, "nvm alias default 24");

  // Nothing installed satisfies engines: propose nothing rather than
  // something that would fail.
  assert.deepEqual(
    proposeFixes({
      gaps: ["node"],
      declared: { node: ">=22.0.0", ciNode: "22" },
      installedNode: ["v18.0.0"],
    }),
    [],
  );
});

test("a missing tool proposes an install, a wrong pnpm proposes corepack", () => {
  const fixes = proposeFixes({
    tools: [
      { name: "terraform", ok: false, present: false, why: "infra" },
      { name: "pnpm", ok: false, present: true, problem: "wrong", why: "builds" },
    ],
    declared: { pnpm: "11.21.0" },
  });

  assert.deepEqual(fixes.map((f) => f.command), [
    "brew install terraform",
    "corepack use pnpm@11.21.0",
  ]);
});

test("a MISSING pnpm is corepack's problem, never brew's", () => {
  // package.json's packageManager means corepack provisions pnpm, and it
  // lives inside the active node version. Observed directly: repairing nvm's
  // default moved node from v24 to v22 and pnpm vanished, because it had
  // only ever been installed under v24. `brew install pnpm` would have
  // "fixed" that by installing a second, unmanaged copy.
  const [fix] = proposeFixes({
    tools: [{ name: "pnpm", ok: false, present: false, why: "builds" }],
    declared: { pnpm: "11.21.0" },
  });
  assert.equal(fix.command, "corepack enable");
  assert.equal(fix.shell, true, "corepack needs the shell's active node");
});

test("the node switch is offered BEFORE corepack, and drags it along", () => {
  // Not cosmetic. pnpm is provisioned per node version, so a corepack fix
  // applied before the switch installs the shim for the version being
  // switched away from — leaving pnpm missing after the very repair that was
  // meant to leave the machine working.
  const fixes = proposeFixes({
    gaps: ["node"],
    declared: { node: ">=22.0.0", ciNode: "22", pnpm: "11.21.0" },
    installedNode: ["v22.23.2", "v24.19.0"],
  });

  assert.deepEqual(fixes.map((f) => f.command), [
    "nvm alias default 22",
    "corepack enable",
  ]);
  assert.match(fixes[1].detail, /after the node switch/);
});

test("corepack is offered once, not twice", () => {
  // Both a missing pnpm and a node switch want it; proposing it twice would
  // ask the developer the same question two ways.
  const fixes = proposeFixes({
    gaps: ["node"],
    tools: [{ name: "pnpm", ok: false, present: false, why: "builds" }],
    declared: { node: ">=22.0.0", ciNode: "22", pnpm: "11.21.0" },
    installedNode: ["v22.23.2"],
  });
  assert.equal(fixes.filter((f) => f.id === "corepack").length, 1);
});

test("an off-PATH tool proposes a PATH line, not an install", () => {
  const [fix] = proposeFixes({
    tools: [{ name: "psql", ok: false, present: false, why: "recovery",
              foundAt: "/opt/homebrew/opt/postgresql@16/bin" }],
  });
  assert.equal(fix.command, undefined, "must not offer to reinstall it");
  assert.equal(fix.appendToRc, 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"');
  assert.equal(fix.rcFile, ".zshenv", "PATH belongs where every zsh reads it");
});

test("a wrong psql major proposes the right formula, not an upgrade", () => {
  // brew keeps postgresql@15 and @16 side by side; upgrading 15 never
  // produces 16.
  const [fix] = proposeFixes({
    tools: [{ name: "psql", ok: false, present: true, why: "x", problem: "major 16 wanted." }],
    declared: { psql: "16" },
  });
  assert.equal(fix.command, "brew install postgresql@16");
});

test("installedNodeVersions ignores anything that is not a version", () => {
  assert.deepEqual(
    installedNodeVersions("v22.23.2\nv24.19.0\n\nnot-a-version\n"),
    ["v22.23.2", "v24.19.0"],
  );
  assert.deepEqual(installedNodeVersions(null), []);
});

test("a tool only interactive shells find gets a ~/.zshenv PATH line", () => {
  // nvm loads from ~/.zshrc, which non-interactive shells never read — so
  // hooks, editor terminals and spawned scripts see nothing.
  const [fix] = proposeFixes({
    nonInteractiveMissing: ["node", "pnpm"],
    nodeBinDir: "/Users/x/.nvm/versions/node/v22.23.2/bin",
  });

  assert.equal(fix.rcFile, ".zshenv", "every zsh reads it; .zshrc does not");
  assert.equal(
    fix.appendToRc,
    'export PATH="/Users/x/.nvm/versions/node/v22.23.2/bin:$PATH"',
  );
  assert.match(fix.detail, /needs updating when you switch/, "states the trade");

  // Nothing missing, or nowhere to point at: propose nothing.
  assert.deepEqual(proposeFixes({ nonInteractiveMissing: [], nodeBinDir: "/x" }), []);
  assert.deepEqual(proposeFixes({ nonInteractiveMissing: ["node"], nodeBinDir: null }), []);
});

test("a shell-significant character in a path is escaped, not executed", () => {
  // These lines are appended to a shell profile and run on every start, so an
  // unescaped `"` or `$(...)` in a directory name would not merely corrupt
  // the file — it would execute.
  assert.equal(shellQuote('/tmp/a"b'), '/tmp/a\\"b');
  assert.equal(shellQuote("/tmp/$(whoami)"), "/tmp/\\$(whoami)");
  assert.equal(shellQuote("/tmp/`id`"), "/tmp/\\`id\\`");
  assert.equal(shellQuote("/plain/path"), "/plain/path");

  const [fix] = proposeFixes({
    nonInteractiveMissing: ["node"],
    nodeBinDir: '/tmp/a"b/bin',
  });
  assert.ok(!/[^\\]"/.test(fix.appendToRc.slice(13, -8)), "quote left unescaped");
});

test("a fix writes to the file it names, not always ~/.zshrc", () => {
  // The PATH repair exists FOR ~/.zshenv, the file every zsh reads. Writing
  // it to ~/.zshrc left the non-interactive problem unfixed while the
  // success line claimed otherwise.
  const [pathFix] = proposeFixes({
    nonInteractiveMissing: ["node"],
    nodeBinDir: "/x/bin",
  });
  assert.equal(pathFix.rcFile, ".zshenv");

  const [declared] = proposeFixes({
    variables: [
      { name: "TF_VAR_x", ok: false, emptyMeans: "off", why: "w", breaks: "b" },
    ],
  });
  assert.equal(declared.rcFile, undefined, "a variable belongs in ~/.zshrc");
});

test("co-location alone does not prove pnpm is corepack's", () => {
  // A globally installed pnpm can sit in node's own bin directory and would
  // read as corepack's while still ignoring the pin.
  const paths = {
    pnpmPath: "/n/bin/pnpm",
    nodePath: "/n/bin/node",
  };
  assert.equal(
    corepackState({ ...paths, readHead: () => "#!/usr/bin/env node\nrequire('corepack')" }).state,
    "corepack",
  );
  assert.equal(
    corepackState({ ...paths, readHead: () => "#!/usr/bin/env node\n// a real pnpm bundle" }).state,
    "unmanaged",
  );
  // Unreadable: claim nothing rather than accuse.
  assert.equal(corepackState({ ...paths, readHead: () => null }).state, "unknown");
});

test("pnpm that is not corepack's is reported and repaired", () => {
  // It satisfies `command -v` while ignoring packageManager entirely, so the
  // version drifts from the pin with nothing failing.
  const unmanaged = corepackState({
    pnpmPath: "/opt/homebrew/bin/pnpm",
    nodePath: "/Users/x/.nvm/versions/node/v22.23.2/bin/node",
  });
  assert.equal(unmanaged.ok, false);
  assert.equal(unmanaged.state, "unmanaged");

  const shim = corepackState({
    pnpmPath: "/Users/x/.nvm/versions/node/v22.23.2/bin/pnpm",
    nodePath: "/Users/x/.nvm/versions/node/v22.23.2/bin/node",
    // Co-location is necessary but not sufficient, so the shim's own
    // contents are what settle it.
    readHead: () => "#!/usr/bin/env node\nrequire('corepack/dist/pnpm.js')",
  });
  assert.equal(shim.ok, true);
  assert.equal(shim.state, "corepack");

  const [fix] = proposeFixes({ corepack: unmanaged, declared: { pnpm: "11.21.0" } });
  assert.equal(fix.command, "corepack enable");
  assert.match(fix.detail, /not corepack's/);
});
