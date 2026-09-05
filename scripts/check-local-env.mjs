#!/usr/bin/env node
/**
 * Does this machine have the credentials this repo's tooling needs?
 *
 * The startup contract (packages/config/src/env-contract.js) covers what the
 * APPLICATIONS need at boot. This covers the other half: what a DEVELOPER's
 * shell needs before `terraform apply`, `git push` and the operational
 * scripts behave correctly. Nothing here reaches production.
 *
 * The list is DERIVED, never hand-maintained, from three sources:
 *
 *   AI tooling      @medinstru/config's AI_ROLES, via each role's apiKeyEnv
 *   Terraform       every `sensitive = true` variable -- those are exactly
 *                   the ones that cannot live in a committed tfvars
 *   Provider auth   the small declared table below
 *
 * So adding a sensitive Terraform variable, or a new AI role, makes this
 * check ask for it the same day — the failure the whole env-contract series
 * exists to remove, applied to the laptop instead of the deployment.
 *
 * Run it as `pnpm env:check`, which goes through
 * scripts/check-local-env.sh -- that wrapper exists to report a missing node,
 * which this file cannot do, being a node script.
 *
 * VALUES ARE NEVER PRINTED. Only whether something is set, and how long it
 * is. This file exists partly because four live credentials were read out of
 * a dotfile while debugging something unrelated; a checker that echoed them
 * would be worse than no checker.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_ROLES } from "../packages/config/src/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Provider credentials, which are a CONVENTION rather than a declaration.
 *
 * Terraform providers read these from the environment by name; nothing in
 * our .tf files mentions them, so they cannot be derived like the rest and
 * are the one hand-maintained part of this file.
 */
const PROVIDER_CREDENTIALS = [
  {
    name: "RENDER_API_KEY",
    why: "Terraform's Render provider, and scripts/render-shadowed-env.mjs.",
    emptyMeans: "you do not run the render stack from this machine",
    breaks: "terraform plan/apply on the render stack cannot authenticate.",
  },
  {
    name: "CLOUDFLARE_API_TOKEN",
    why: "Terraform's Cloudflare provider (DNS, R2, cache rules).",
    emptyMeans: "you do not run the cloudflare stack from this machine",
    breaks: "terraform plan/apply on the cloudflare stack cannot authenticate.",
  },
];

/**
 * Terraform variables marked `sensitive = true`, by name.
 *
 * NO BRACE COUNTING, NO DEFAULT DETECTION. Both were tried and both were a
 * hand-written HCL parser in disguise -- successive reviews found braces in
 * string literals, an object field named `default`, one-line blocks, block
 * comments and heredocs, each one a false NEGATIVE that dropped a variable
 * from the report while the script exited 0.
 *
 * What is left is the one association HCL makes unambiguous: a
 * `sensitive = true` line belongs to the nearest `variable "..."` header
 * above it. That is all this needs, because `sensitive` is exactly the
 * property that makes a value unable to live in a committed tfvars and
 * therefore something the shell must supply.
 *
 * Where it is still imprecise -- a `sensitive = true` inside a block comment,
 * say -- it OVER-reports: it asks for a variable that does not need setting.
 * That is loud and one `export NAME=` away from resolved, rather than a
 * silent pass. Every remaining inaccuracy fails in that direction by design.
 */
function scanSensitive(source, { skipBodies }) {
  const names = [];
  let current = null;
  let heredoc = null;
  let inBlockComment = false;

  for (const raw of source.split("\n")) {
    // A COMPLETE `/* ... */` span is removed before anything else looks at
    // the line. `/* note */ variable "secret" {` was invisible to both
    // passes: the skipping pass does not enter comment mode because the line
    // also closes it, and the reading pass's anchored header regex cannot
    // match through the leading comment. Neither recorded the header, so the
    // `sensitive` below it attached to whatever came before -- a silent miss,
    // which is the one direction the union exists to rule out.
    const line = raw.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, " ");

    if (skipBodies) {
      if (heredoc !== null) {
        if (line.trim() === heredoc) heredoc = null;
        continue;
      }
      if (inBlockComment) {
        if (line.includes("*/")) inBlockComment = false;
        continue;
      }
      // A COMMENT is not an opener. `# for example: <<EOT` used to put this
      // pass inside a heredoc that never ends, swallowing every declaration
      // after it -- the likeliest way to derail it, and the cheapest to rule
      // out.
      const opener = /^\s*(#|\/\/)/.test(line)
        ? null
        : /<<-?\s*"?([\w-]+)"?/.exec(line);
      if (opener) {
        heredoc = opener[1];
        continue;
      }
      if (line.includes("/*") && !line.includes("*/")) {
        inBlockComment = true;
        continue;
      }
    }

    const header = /^\s*variable\s+"([^"]+)"/.exec(line);
    if (header) {
      current = header[1];
      if (/\bsensitive\s*=\s*true/.test(line.slice(header[0].length))) {
        names.push(current);
        current = null;
      }
      continue;
    }
    if (current && /\bsensitive\s*=\s*true/.test(line)) {
      names.push(current);
      current = null;
    }
  }
  return names;
}

/**
 * Terraform variables marked `sensitive = true`, by name.
 *
 * THE UNION OF TWO PASSES, and that is what makes the over-report guarantee
 * real rather than merely claimed.
 *
 * One pass skips heredoc and block-comment bodies; the other reads every
 * line. Each has a failure mode and they are opposites:
 *
 *   prose inside a heredoc mentioning `variable "x"`   derails the reading pass
 *   a comment that merely LOOKS like a heredoc opener  derails the skipping pass
 *
 * Whichever ONE is derailed, the other still attributes correctly, so a name
 * is added rather than lost. Over-reporting costs one `export NAME=` and is
 * visible; under-reporting silently omits a credential and exits 0, which is
 * the failure this whole script exists to prevent.
 *
 * The residual, stated rather than glossed: a file that derails BOTH passes
 * before the same declaration can still lose it. That needs a fake opener
 * outside a comment AND a real heredoc whose body starts a line with
 * `variable "`, in the same file. Ruling it out entirely means an HCL
 * parser; what is here narrows it to a construct nobody writes by accident,
 * and `terraform validate` would not object to it either.
 *
 * Successive reviews found five separate ways a single-pass scanner
 * under-reports (braces in literals, an object field named `default`,
 * one-line blocks, heredoc decoys, comment-and-code on one line). Rather
 * than chase a sixth, the construction removes the direction that matters.
 */
export function sensitiveVariables(source) {
  return [
    ...new Set([
      ...scanSensitive(source, { skipBodies: true }),
      ...scanSensitive(source, { skipBodies: false }),
    ]),
  ];
}

/**
 * What each Terraform stack needs from the shell.
 *
 * Only the sensitive ones. Everything else either has a default or lives in
 * a committed tfvars, and neither needs a developer to do anything.
 *
 * The quiet failure this catches: these all have an empty default, so
 * `terraform apply` succeeds with nothing set and whatever they configure --
 * R2 uploads, WhatsApp delivery -- is simply off in production, with no
 * error anywhere. Declaring one empty says that on purpose.
 */
export function terraformRequirements(stacks) {
  return stacks.flatMap(({ stack, variables }) =>
    sensitiveVariables(variables).map((name) => ({
      name: `TF_VAR_${name}`,
      why: `Terraform input \`${name}\` (${stack} stack), sensitive so it cannot live in a committed tfvars.`,
      emptyMeans: `the ${stack} stack applies an empty value, so whatever this configures is off`,
      breaks: `terraform applies an empty value — whatever it configures is silently off.`,
    })),
  );
}

/** The API keys the repo's AI automations read, by role. */
export function toolingRequirements(roles) {
  const byKey = new Map();

  for (const [roleName, role] of Object.entries(roles)) {
    if (!role.apiKeyEnv) continue;
    const entry = byKey.get(role.apiKeyEnv) ?? { roles: [] };
    entry.roles.push(roleName);
    byKey.set(role.apiKeyEnv, entry);
  }

  return [...byKey].map(([name, { roles: usedBy }]) => ({
    name,
    why: `AI role(s): ${usedBy.join(", ")}.`,
    // OPENAI_API_KEY may NOT be empty. CLAUDE.md records why: an unset key
    // makes the pre-push precheck skip silently, and that read as routine
    // output for an entire session while CI kept raising findings it would
    // have caught. Setting PRECHECK_OPTOUT is the way to decline it
    // deliberately, so an empty key has no separate meaning worth allowing.
    emptyMeans:
      name === "OPENAI_API_KEY"
        ? null
        : "that automation is not run from this machine; CI supplies its own",
    // The documented way to decline the precheck deliberately. Any non-empty
    // value counts, matching scripts/ai-code-review-precheck.mjs exactly
    // (`if (process.env.PRECHECK_OPTOUT)`) -- narrowing this to "1" would
    // make the checker and the hook it describes disagree about whether the
    // precheck is opted out, which is worse than either rule alone.
    declinedBy: name === "OPENAI_API_KEY" ? "PRECHECK_OPTOUT" : null,
    breaks:
      name === "OPENAI_API_KEY"
        ? "the pre-push review precheck skips silently, so findings cost a full CI round trip instead."
        : "that automation cannot run locally.",
  }));
}

/**
 * The subset the LOCAL DEV STACK actually needs.
 *
 * terraform, psql and gh are for infrastructure, database recovery and PR
 * workflows -- none of which is starting Postgres and the API. Blocking
 * `./scripts/dev.sh` on them would stop someone with node, pnpm and docker
 * from working for a reason unrelated to what they are doing, which is how a
 * preflight becomes something people comment out.
 *
 * They are still CHECKED and still reported; they simply do not gate.
 */
export const STACK_TOOLS = ["node", "pnpm", "docker"];

export const REQUIRED_TOOLS = [
  {
    name: "pnpm",
    why: "every build, test and script in this workspace.",
    // package.json's `packageManager` is an exact pin, and corepack honours
    // it -- so a different version means corepack is not managing pnpm here.
    floor: { kind: "exact", from: "package.json packageManager" },
  },
  {
    name: "terraform",
    why: "infra/terraform — Render and Cloudflare.",
    floor: { kind: "min", from: "versions.tf required_version" },
  },
  {
    name: "psql",
    why: "the database recovery steps in CLAUDE.md's known gotchas.",
    // The dev stack runs postgres:16-alpine. A client from a different major
    // is what produces the confusing half-working session.
    floor: { kind: "major", from: "docker-compose postgres image" },
  },
  // No declared requirement anywhere in the repo, so none is invented here.
  // Their version is reported; nothing is enforced against a number nobody
  // chose.
  { name: "docker", why: "the dev stack (./scripts/dev.sh) and the smoke tests." },
  { name: "git", why: "the whole workflow." },
  { name: "gh", why: "opening PRs, reading CI, the review workflows." },
];

/** The first dotted version in a `--version` line. */
export function parseVersion(text) {
  // Every tool words it differently: "Terraform v1.15.8", "git version
  // 2.50.1 (Apple Git-155)", "psql (PostgreSQL) 16.15 (Homebrew)",
  // "Docker version 29.7.2, build a7dcaa", and pnpm's bare "11.21.0".
  // Minor and patch are OPTIONAL. A declared floor is often just a major --
  // the postgres image tag is `16` -- and requiring a dot made that parse to
  // null, which satisfiesFloor treats as "cannot judge" and passes. A psql 15
  // client against a 16 server sailed through.
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** -1, 0 or 1, comparing two parsed versions. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Does `found` satisfy `floor`?
 *
 *   min     at or above it -- a declared `>=` range
 *   exact   the same version -- a pin
 *   major   the same major -- a client/server pairing
 */
export function satisfiesFloor(found, floor) {
  if (!floor?.value) return true;
  const want = parseVersion(floor.value);
  const have = parseVersion(found);
  if (!want || !have) return true;

  if (floor.kind === "exact") return compareVersions(have, want) === 0;
  if (floor.kind === "major") return have[0] === want[0];
  return compareVersions(have, want) >= 0;
}

/**
 * The versions this repo declares, read from where it already declares them.
 *
 * Nothing here is a number someone chose for this file. A floor that is not
 * declared anywhere is not enforced -- inventing one turns a green check into
 * an argument about whose laptop is right.
 */
export function declaredVersions({ root = repoRoot } = {}) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const pkg = JSON.parse(read("package.json"));

  const terraform = /required_version\s*=\s*"([^"]+)"/.exec(
    read("infra/terraform/render/versions.tf"),
  );
  const postgres = /image:\s*postgres:(\d+)/.exec(read("docker-compose.yml"));

  // What CI actually runs, so a proposed local version matches it.
  const ciNode = /node-version:\s*"?(\d+)/.exec(
    read(".github/workflows/ci.yml"),
  );

  return {
    node: pkg.engines?.node ?? null,
    ciNode: ciNode ? ciNode[1] : null,
    pnpm: pinnedPnpmVersion(pkg),
    terraform: terraform ? terraform[1] : null,
    psql: postgres ? postgres[1] : null,
  };
}

/** Run `<tool> --version` and return its first line, or null if absent. */
export function probeVersion(tool, run) {
  try {
    return run(tool).split("\n")[0].trim();
  } catch {
    return null;
  }
}

/** Homebrew's prefix, or null where brew is not installed. */
function defaultBrewPrefix() {
  try {
    return execFileSync("brew", ["--prefix"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Node versions nvm has installed, or none when nvm is absent. */
function defaultNodeVersions() {
  try {
    return readdirSync(join(process.env.HOME ?? "", ".nvm/versions/node")).filter(
      (entry) => /^v\d+\./.test(entry),
    );
  } catch {
    return [];
  }
}

const defaultLocate = (name, dirs) =>
  locateOffPath(name, dirs, (candidate) => existsSync(candidate));

const defaultRun = (tool) =>
  execFileSync(tool, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * Is each tool present, and does its version satisfy what the repo declares?
 *
 * A version violation FAILS. It was a note once, on the reasoning that
 * corepack reconciles pnpm anyway -- but a check that reports a wrong
 * version and exits 0 is one people stop reading, and the wrong version is
 * exactly what produces a confusing failure three steps later.
 */
export function checkTools(
  tools,
  {
    run = defaultRun,
    declared = {},
    brewPrefix = defaultBrewPrefix(),
    locate = defaultLocate,
    nodeVersions = defaultNodeVersions(),
  } = {},
) {
  return tools.map((tool) => {
    const version = probeVersion(tool.name, run);
    if (version === null) {
      // Look for it before declaring it missing: installed-but-off-PATH and
      // not-installed need opposite fixes.
      const foundAt = locate
        ? locate(
            tool.name,
            candidateBinDirs(tool.name, {
              home: process.env.HOME,
              brewPrefix,
              postgresMajor: declared.psql,
              nodeVersions,
            }),
          )
        : null;
      return {
        ...tool,
        present: false,
        ok: false,
        version: null,
        foundAt,
        problem: foundAt
          ? `installed at ${foundAt}, but not on PATH.`
          : null,
      };
    }

    const floor = tool.floor
      ? { ...tool.floor, value: declared[tool.name] }
      : null;

    if (floor?.value && !satisfiesFloor(version, floor)) {
      const wording =
        floor.kind === "exact"
          ? `must be exactly ${floor.value}`
          : floor.kind === "major"
            ? `must be major ${floor.value}`
            : `must be ${floor.value}`;
      return {
        ...tool,
        present: true,
        ok: false,
        version,
        problem: `${wording} (${floor.from}).`,
      };
    }
    return { ...tool, present: true, ok: true, version, problem: null };
  });
}

/** Is the running node new enough for what this repo installs? */
export function checkNode(declaredRange, actual = process.version) {
  const ok = satisfiesFloor(actual, { kind: "min", value: declaredRange });
  return {
    name: "node",
    why: "everything.",
    present: true,
    ok,
    version: actual,
    problem: ok ? null : `must be ${declaredRange} (package.json engines).`,
  };
}

/** The pnpm version package.json pins, or null. */
export function pinnedPnpmVersion(packageJson) {
  const match = /^pnpm@(\S+)$/.exec((packageJson.packageManager ?? "").trim());
  return match ? match[1] : null;
}

/**
 * Does a FRESH shell find these tools, or only this one?
 *
 * The check that would have caught the failure that prompted all of this.
 * `node` worked in the terminal someone had open and not in a new one,
 * because nvm's `default` alias pointed at an LTS release that was never
 * installed -- so `nvm use default` failed silently and put nothing on PATH.
 * Every probe that inherits the caller's environment reports success there,
 * which is why the first diagnosis of it was wrong.
 *
 * So the probe starts from NOTHING: `env -i` with only HOME, in a login
 * interactive shell, which is what a new terminal actually is. Anything the
 * current process already had is deliberately discarded.
 *
 * Best-effort by design. An unknown login shell, or one that cannot be
 * spawned, yields null and the section is skipped -- this is a diagnosis
 * aid, and a machine it cannot introspect must not fail the whole check.
 */
export function freshShellTools(names, { shell = process.env.SHELL, run } = {}) {
  if (!shell || !/\/(zsh|bash)$/.test(shell)) return null;

  // ONE invocation, not one per tool: a login shell reads the whole profile
  // each time, and six of those is a visible pause on a check meant to be
  // cheap enough to run before every dev session.
  // `; true` because the shell exits with the status of its LAST command --
  // so a script whose final `command -v` finds nothing exits non-zero, the
  // spawn throws, and the catch below reports "cannot introspect" for the one
  // case that matters most: everything missing.
  const script = `${names
    .map((n) => `command -v ${n} >/dev/null 2>&1 && echo "${n}"`)
    .join("; ")}; true`;

  try {
    const output = (run ?? defaultFreshRun)(shell, script);
    const found = new Set(output.split("\n").map((l) => l.trim()).filter(Boolean));
    return names.map((name) => ({ name, resolves: found.has(name) }));
  } catch {
    return null;
  }
}

const defaultFreshRun = (shell, script) =>
  execFileSync("env", ["-i", `HOME=${process.env.HOME}`, "TERM=dumb", shell, "-lic", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });

/**
 * Tools this process can run that a new terminal could not.
 *
 * PATH belongs in ~/.zshenv, which every zsh reads. That is the opposite of
 * the advice for secrets, and deliberately so: a secret in .zshenv is handed
 * to every subprocess, while a PATH entry NOT there is missing from every
 * non-interactive one -- hooks, editors, and anything a script spawns.
 */
export function shellGaps(tools, fresh) {
  if (!fresh) return [];
  const resolves = new Map(fresh.map((f) => [f.name, f.resolves]));
  return tools
    .filter((t) => t.ok && t.present && resolves.get(t.name) === false)
    .map((t) => t.name);
}

/**
 * Where a tool might be installed but invisible.
 *
 * "Not on PATH" and "not installed" look identical to `command -v` and need
 * opposite fixes -- one is a PATH line, the other a download. Getting that
 * backwards means telling someone to install software they already have.
 *
 * The keg-only case is real here: Homebrew does not link postgresql@N into
 * bin, which is exactly why CLAUDE.md's recovery steps spell out
 * /opt/homebrew/opt/postgresql@16/bin/psql in full. The major comes from the
 * compose file, so it follows the image rather than being written twice.
 */
export function candidateBinDirs(
  name,
  { home, brewPrefix, postgresMajor, nodeVersions = [] },
) {
  const dirs = [];

  if (brewPrefix) {
    dirs.push(join(brewPrefix, "bin"));
    if (name === "psql" && postgresMajor) {
      dirs.push(join(brewPrefix, "opt", `postgresql@${postgresMajor}`, "bin"));
    }
  }
  // node and pnpm live under a VERSION's bin, not under the versions
  // directory itself. This pushed `~/.nvm/versions/node`, so locateOffPath
  // looked for `~/.nvm/versions/node/node` -- a path that never exists, so an
  // nvm-installed node was reported "not installed" rather than "off PATH",
  // and the fix offered would have been `brew install node`.
  //
  // The versions are passed in rather than read here, so this stays a pure
  // function; the caller enumerates the directory once.
  if ((name === "node" || name === "pnpm") && home) {
    for (const version of nodeVersions) {
      dirs.push(join(home, ".nvm", "versions", "node", version, "bin"));
    }
  }
  return dirs;
}

/** The directory holding `name`, if one of `dirs` has it. */
export function locateOffPath(name, dirs, exists) {
  for (const dir of dirs) {
    if (exists(join(dir, name))) return dir;
  }
  return null;
}

/**
 * What could be done about each problem, if the developer agrees.
 *
 * THE HARD LINE: a fix may change CONFIGURATION and may never invent a
 * VALUE. Pointing nvm at a version already installed, installing a tool from

/**
 * Everything this repo wants declared in a developer's shell.
 *
 * A missing Terraform stack is an ERROR rather than a skip: silently
 * dropping one would drop every credential it needs while the check still
 * reported success.
 */
export function requirements({ root = repoRoot, roles = AI_ROLES } = {}) {
  const stacks = ["render", "cloudflare"].map((stack) => {
    const variablesPath = join(root, "infra/terraform", stack, "variables.tf");
    // Missing is an ERROR, not a skip. Silently dropping a stack whose file
    // moved would drop every credential it needs while the check still
    // reported success -- the exact false pass this script exists to stop.
    if (!existsSync(variablesPath)) {
      throw new Error(
        `${variablesPath} not found — cannot tell what the ${stack} stack needs.`,
      );
    }
    return { stack, variables: readFileSync(variablesPath, "utf8") };
  });

  return [
    ...toolingRequirements(roles),
    ...terraformRequirements(stacks),
    ...PROVIDER_CREDENTIALS,
  ];
}

/**
 * Judge each requirement against an environment.
 *
 * | State  | Verdict                                                    |
 * |--------|------------------------------------------------------------|
 * | set    | fine                                                        |
 * | empty  | fine IF the variable documents what empty means, else error |
 * | absent | always an error — nobody has decided anything               |
 *
 * The same rule the startup contract applies, for the same reason: an empty
 * value is a decision on record, and a missing one is an oversight that
 * looks identical to a deliberate choice until something breaks.
 */
export function evaluate(wanted, env) {
  return wanted.map((item) => {
    const raw = env[item.name];
    const state =
      raw === undefined ? "absent" : raw.trim() === "" ? "empty" : "set";

    const declined = Boolean(item.declinedBy && env[item.declinedBy]);
    const ok =
      state === "set" ||
      declined ||
      (state === "empty" && Boolean(item.emptyMeans));

    return {
      ...item,
      state,
      ok,
      declined,
      shown: state === "set" ? mask(raw) : null,
    };
  });
}

/**
 * A value's shape, never any of its content.
 *
 * EVERYTHING here is a credential, so there is no "safe to show" case to
 * distinguish and no prefix worth revealing -- a leading `sk-proj-` or
 * `rnd_` identifies the key's owner and service to anyone reading over a
 * shoulder or scrolling a shared terminal. The length alone answers the
 * only question a checker needs to: is something plausible in there.
 *
 * Written rather than borrowed: the contract package's displaySafe strips
 * control characters, it does not mask, and reaching for it here printed
 * three live secrets to the terminal on the first run of this script.
 */
export function mask(value) {
  return `*** (${value.length} chars)`;
}

const ICON = { set: "\u2713", empty: "\u25cb", absent: "\u2717" };
export function reportTools(tools) {
  const width = Math.max(...tools.map((t) => t.name.length));
  const lines = ["", "  TOOLS"];

  for (const t of tools) {
    const state = t.version ?? (t.foundAt ? "(INSTALLED, NOT ON PATH)" : "(NOT INSTALLED)");
    lines.push(
      `  ${t.ok ? "\u2713" : "\u2717"} ${t.name.padEnd(width)}  ${state}` +
        (t.problem ? `\n      ${t.problem}` : ""),
    );
  }

  const missing = tools.filter((t) => !t.ok);
  if (missing.length > 0) {
    lines.push("", "  PROBLEMS:");
    for (const t of missing) {
      lines.push(`    ${t.name} — ${t.why}`);
    }
    lines.push(
      "",
      // Deliberately no "--fix" hint: that flag arrives with the repair
      // flow in a later change. Telling someone to re-run with an option
      // this build ignores is worse than saying nothing.
      `    brew install ${missing.filter((t) => !t.foundAt).map((t) => t.formula ?? t.name).join(" ")}`.trimEnd(),
    );
  }

  return lines.join("\n");
}

/** Tools this shell has that a new terminal would not. */
export function reportShellGaps(names) {
  if (names.length === 0) return "";
  return [
    "",
    "  ONLY IN THIS SHELL — a new terminal would not find these:",
    ...names.map((n) => `    ${n}`),
    "",
    "  They work here because this process inherited them, not because your",
    "  shell config provides them. Anything starting from a clean environment",
    "  — a git hook, an editor's terminal, a script — will fail.",
    "",
    "  For nvm specifically, the usual cause is `default` pointing at a version",
    "  that is not installed, which makes `nvm use default` fail silently:",
    "",
    "    nvm current            # 'none' means nothing was activated",
    "    nvm alias default 22   # pin it to an installed version",
    "",
    "  PATH belongs in ~/.zshenv, which every zsh reads — the opposite of the",
    "  advice for secrets below, and deliberately so.",
  ].join("\n");
}


export function report(results) {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = [""];

  for (const r of results) {
    // A declined requirement is satisfied, so it must not be rendered with
    // the failure icon above a line saying everything is declared. A report
    // that contradicts itself is one people stop reading.
    const icon = r.declined ? "\u2013" : ICON[r.state];
    const shown = r.declined
      ? `(declined via ${r.declinedBy})`
      : r.state === "set"
        ? r.shown
        : r.state === "empty"
          ? "(empty)"
          : "(NOT SET)";
    lines.push(`  ${icon} ${r.name.padEnd(width)}  ${shown}`);
  }

  const failures = results.filter((r) => !r.ok);
  // `!r.declined`: a declined entry is satisfied by its opt-out, not by an
  // empty value, and it may have no emptyMeans at all -- listing it here
  // printed "OPENAI_API_KEY — null."
  const declaredEmpty = results.filter(
    (r) => r.state === "empty" && r.ok && !r.declined,
  );

  if (declaredEmpty.length > 0) {
    lines.push("", "  Deliberately empty:");
    for (const r of declaredEmpty) lines.push(`    ${r.name} — ${r.emptyMeans}.`);
  }

  if (failures.length > 0) {
    lines.push("", "  PROBLEMS:");
    for (const r of failures) {
      lines.push(
        `    ${r.name} is ${r.state === "empty" ? "empty, and must not be" : "not set"}.`,
        `      ${r.why}`,
        `      Without it: ${r.breaks}`,
      );
      if (r.emptyMeans) {
        lines.push(
          `      To decline it on purpose: export ${r.name}=  (means: ${r.emptyMeans})`,
        );
      }
    }
    lines.push(
      "",
      `  ${failures.length} problem(s). Add them to ~/.zshrc, then \`source ~/.zshrc\`.`,
      "  Prefer ~/.zshrc over ~/.zshenv: .zshenv is read by EVERY zsh process,",
      "  interactive or not, so anything there is handed to every subprocess.",
      "",
    );
  } else {
    lines.push("", "  OK — every variable is declared.", "");
  }

  return lines.join("\n");
}

/**
 * Ask, then act. Never the other way round.
 *
 * Defaults to NO on anything that is not an explicit "y": a blank line, EOF,
 * a stray keypress. These edit the developer's machine and their shell
 * profile, so ambiguity has to mean stop.
 */

// CLI. Exits non-zero when a tool is missing, a version is wrong, or a
// variable is undeclared, so it can gate a setup script.
//
// `--tools-only` is what scripts/dev.sh uses: the dev stack genuinely needs
// node, pnpm and docker, and genuinely does not need a WhatsApp token. A
// preflight that blocked the local stack on an unrelated credential is one
// people would route around within a week.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const toolsOnly = process.argv.includes("--tools-only");
  // `--gate-stack`: report everything, but let only a STACK-essential tool
  // stop the caller. What dev.sh wants -- a missing `gh` is worth saying and
  // is no reason to refuse to start Postgres.
  const gateStack = process.argv.includes("--gate-stack");
  const declared = declaredVersions();

  const tools = [
    checkNode(declared.node),
    ...checkTools(REQUIRED_TOOLS, { declared }),
  ];
  console.log(reportTools(tools));

  const gaps = shellGaps(tools, freshShellTools(tools.map((t) => t.name)));
  const gapReport = reportShellGaps(gaps);
  if (gapReport) console.log(gapReport);

  let variables = [];
  if (!toolsOnly) {
    variables = evaluate(requirements(), process.env);
    console.log("\n  VARIABLES");
    console.log(report(variables));
  }

  // A shell gap does NOT fail the check. Everything works in the shell you
  // are in, which is the one running this -- it is a warning about the next
  // one, and failing here would block work that is about to succeed.
  // Under --gate-stack only a stack-essential tool stops the caller.
  // Everything else is still checked and still printed; it simply is not a
  // reason to refuse to start Postgres.
  const blocking = gateStack
    ? tools.filter((t) => STACK_TOOLS.includes(t.name) && !t.ok)
    : tools.filter((t) => !t.ok);

  const ok = blocking.length === 0 && variables.every((v) => v.ok);
  process.exit(ok ? 0 : 1);
}
