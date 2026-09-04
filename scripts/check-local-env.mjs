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
 * Run it as `pnpm env:check`.
 *
 * VALUES ARE NEVER PRINTED. Only whether something is set, and how long it
 * is. This file exists partly because four live credentials were read out of
 * a dotfile while debugging something unrelated; a checker that echoed them
 * would be worse than no checker.
 */
import { existsSync, readFileSync } from "node:fs";
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

// CLI. Exits non-zero when anything is undeclared, so it can gate a setup
// script. Declining a variable is still possible -- declare it empty and the
// reason is on record, rather than being indistinguishable from forgetting it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = evaluate(requirements(), process.env);
  console.log(report(results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
