/**
 * Drift checks for ci.yml's environment values.
 *
 * ci.yml cannot import JavaScript, so it declares these values literally and
 * this keeps them equal to the contract — the same approach that pins
 * Terraform to LOCALES.
 *
 * Every function takes the workflow SOURCE rather than reading the file, so
 * each rejection branch can be tested against a fixture. They were verified
 * by hand-editing the real ci.yml before that, which proved the logic and
 * left nothing behind to catch a regression.
 *
 * These are regex scans, not YAML parsing, and that is a deliberate limit:
 * `test-ci-scripts` runs without `pnpm install`, so no parser is available,
 * and hand-rolling one is the trap that produced this repo's .env-parser
 * bugs. `unreadableSpellings` below turns what the scans cannot read into a
 * failure instead of a silent gap.
 *
 * WHAT THIS DEFENDS AGAINST, stated so the limit is a decision rather than
 * an oversight: ACCIDENTS. A value edited without the contract, a
 * DATABASE_URL pasted into the wrong job, a service block overriding the
 * account, a second env block added at the bottom of the file.
 *
 * AND IT IS THE OUTER LAYER, NOT THE PREVENTION. These checks run in
 * test-ci-scripts, concurrently with test-api-e2e — so a bad configuration
 * would already be running by the time they fail. What actually stops the
 * destructive case is inside that job:
 * `assertConnectedToTestDatabase` runs in every e2e spec's beforeAll, asks
 * Postgres `SELECT current_database()`, and refuses to truncate anything
 * whose name does not end in `_test`. That cannot be fooled by env-var
 * indirection, because it reads the connection rather than the variable.
 *
 * So the layering is: the runtime guard prevents the damage; this stops the
 * misconfiguration from being merged in the first place. Neither replaces
 * the other, and neither should be described as doing the other's job.
 *
 * The spec check in the test file is a LINT over that guard's call sites —
 * it catches the call being deleted, commented out or moved, not Jest's
 * execution order, which would need an AST and a lifecycle model.
 *
 * It is NOT an adversarial boundary, and cannot be. Anyone who can edit
 * ci.yml can add a step that runs arbitrary code with the repository's
 * secrets — reaching for `? DATABASE_URL` explicit-key syntax to smuggle a
 * value past a regex would be the hardest available route to a thing they
 * could do in one line. So the guard covers the spellings a person might
 * plausibly write, and says so, rather than pretending to be exhaustive.
 */

/** Variables whose value or placement can break a job destructively. */
export const WATCHED = [
  "DATABASE_URL",
  "NEXT_PUBLIC_API_URL",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
];

const WATCHED_RE = `(?:${WATCHED.join("|")})`;

/**
 * A job key at column 2 — quoted or not, any case, trailing comment allowed.
 *
 * Requiring end-of-line after the colon meant `Deploy_Web: # deploy` was not
 * recognised, so that job's lines were attributed to the PREVIOUS one. If
 * that was `migrate`, a production secret in the unrecognised job read as
 * migrate's own, which is the one place a secret is permitted.
 */
const JOB_KEY = /^  ["']?([A-Za-z_][\w-]*)["']?:\s*(?:#.*)?$/;

/** One job's lines, from its key to the next job's. */
export function jobSource(source, name) {
  const lines = source.split("\n");
  // Quoted ids too. jobsAssigningDatabaseUrl strips the quotes and returns
  // `quoted-job`, so an exact-line lookup found nothing and every caller ran
  // `.matchAll` on null.
  const start = lines.findIndex((l) => JOB_KEY.exec(l)?.[1] === name);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && JOB_KEY.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/**
 * `NAME: value` pairs under the `env:` at exactly `indent` spaces.
 *
 * The indentation is required, not inferred. Taking the FIRST `env:` in a
 * job returned a service container's block whenever one appeared above the
 * job-level one — so a job could have no job-level env at all while the
 * check read a service's and passed, leaving every
 * `${{ env.DATABASE_URL }}` in that job resolving to nothing.
 *
 * Job-level is 4; a service container's is 8.
 */
export function envBlock(text, indentOf = 4) {
  if (!text) return null;
  const lines = text.split("\n");
  const header = " ".repeat(indentOf) + "env:";
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return null;

  const indent = indentOf + 2;
  const out = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) < indent) break;
    const m = /^\s*([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) break;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * The workflow-level `env:` — required at column 0.
 *
 * Not merely the first `env:` before `jobs:`: a `workflow_dispatch` input
 * named `env` is nested and would otherwise be taken for it.
 */
export function workflowEnv(source) {
  const head = source.slice(0, source.indexOf("\njobs:"));
  const lines = head.split("\n");
  const start = lines.findIndex((l) => l === "env:");
  if (start === -1) return {};
  return envBlock(lines.slice(start).join("\n"), 0) ?? {};
}


/**
 * Job names that assign DATABASE_URL anywhere in their body.
 *
 * The id pattern accepts uppercase, `_`-leading and quoted forms. It used to
 * accept only lowercase, so a job the scanner did not recognise had its
 * assignments attributed to the PREVIOUS job — and a secret URL in a job
 * following `migrate` read as migrate's own, which is the one place a secret
 * is allowed.
 */
export function jobsAssigningDatabaseUrl(source) {
  const out = new Set();
  let job = null;
  for (const line of source.split("\n")) {
    const m = JOB_KEY.exec(line);
    if (m) job = m[1];
    if (job && /^\s+DATABASE_URL:/.test(line)) out.add(job);
  }
  return [...out];
}

/** Column-0 `env:` blocks. More than one means the checks read only the first. */
export function workflowEnvBlockCount(source) {
  // THE WHOLE FILE, not just the header. A second column-0 `env:` appended
  // after the jobs mapping is still workflow-level and still reaches every
  // job — including test-api-e2e — while a header-only count stayed at one
  // and workflowEnv kept reading the first block.
  return source.split("\n").filter((l) => l === "env:").length;
}

/**
 * Spellings GitHub accepts and the scans above cannot read.
 *
 * Each would slip past every other check here — including the one keeping a
 * DATABASE_URL out of test-api-e2e, where it points that suite at the dev
 * database and its beforeEach truncates every table.
 *
 * @returns {string[]} One description per offending line; empty when clean.
 */
export function unreadableSpellings(source) {
  const offenders = [];

  source.split("\n").forEach((line, i) => {
    const at = `line ${i + 1}: ${line.trim()}`;

    if (new RegExp(`^\\s*["']${WATCHED_RE}["']\\s*:`).test(line)) {
      offenders.push(`${at}   (quoted key)`);
      return;
    }
    // A quoted key carrying a backslash escape. YAML resolves `"\u0044ATABASE_URL"`
    // to DATABASE_URL, which the exact-name test above cannot see. Nothing
    // this workflow legitimately writes needs an escape in a key — the only
    // quoted keys here are inside an embedded JSON heredoc, which has none.
    if (/^\s*"[^"]*\\[^"]*"\s*:/.test(line)) {
      offenders.push(`${at}   (escaped key)`);
      return;
    }
    if (new RegExp(`^\\s*${WATCHED_RE}\\s+:`).test(line)) {
      offenders.push(`${at}   (space before colon)`);
      return;
    }
    // An anchor or alias moves a whole env map somewhere these scans never
    // look: `env: *database_env` assigns variables that appear nowhere in
    // the job's own text.
    if (/^\s*env:\s*[*&]/.test(line)) {
      offenders.push(`${at}   (YAML anchor or alias)`);
      return;
    }
    if (new RegExp(`^\\s*${WATCHED_RE}:\\s*[*&]`).test(line)) {
      offenders.push(`${at}   (YAML anchor or alias)`);
      return;
    }

    // A merge key pulls in a whole anchored map: `<<: *database_env` assigns
    // variables that appear nowhere in the job's own text — the same hole as
    // an alias, and equally invisible to every scan here.
    if (/^\s*<<\s*:/.test(line)) {
      offenders.push(`${at}   (YAML merge key)`);
      return;
    }
    // Explicit-key syntax: `? DATABASE_URL` on one line, `: value` on the
    // next. No `NAME:` scan can see it.
    // The boundary matters: without it `? DATABASE_URL_POOL` is rejected as
    // if it were DATABASE_URL, and a false positive here blocks every PR.
    if (new RegExp(`^\\s*\\?\\s*["']?${WATCHED_RE}(?:["']|\\s|$)`).test(line)) {
      offenders.push(`${at}   (explicit key)`);
      return;
    }

    // `${{ ... }}` is an Actions expression, not a YAML flow map, and it
    // contains braces — so it comes out before asking about braces, or every
    // legitimate reference reads as an inline map.
    const yamlOnly = line.replace(/\$\{\{[^}]*\}\}/g, "");
    // The key may be quoted inside the map — `{ "DATABASE_URL": v }` — so
    // an optional quote is allowed between the name and the colon.
    // Boundaries, or `MY_DATABASE_URL` matches by suffix and a false positive
    // fails a required check.
    const INLINE_KEY = new RegExp(`(?<![\\w$])["']?${WATCHED_RE}["']?\\s*:`);
    if (
      /^\s*env:\s*\{/.test(yamlOnly) ||
      (yamlOnly.includes("{") && INLINE_KEY.test(yamlOnly))
    ) {
      offenders.push(`${at}   (inline map)`);
    }
  });

  return offenders;
}

// ---------------------------------------------------------------------
// The e2e-spec guard lint
// ---------------------------------------------------------------------
//
// A PRESENCE LINT, and deliberately nothing more.
//
// What prevents the damage is assertConnectedToTestDatabase itself: 51 lines
// that ask Postgres `SELECT current_database()` and throw unless the name
// ends in `_test`. It runs on every e2e run, reads the connection rather
// than any variable, and cannot be fooled by env-var indirection — which is
// what caused the incident it exists for.
//
// This checks only that no spec LOSES that call by accident: deleted,
// commented out, written inside a string, left unawaited, or moved out of a
// setup hook. Those are the ways it actually goes missing.
//
// It does NOT model JavaScript or Jest. An earlier version tried: describe
// scoping, beforeAll-versus-beforeEach ordering, hook registration order,
// receiver matching, tagged templates, `describe.each` in both spellings,
// regex literals, TypeScript generics. That reached 526 lines of hand-rolled
// analysis to verify a 51-line guard, and was found wrong in fifteen
// successive review rounds — each fix revealing the next construct it
// mishandled, which is what writing a parser by accident looks like.
//
// The trade is deliberate: this can miss an exotic arrangement, and the
// runtime guard still catches every one of them. The reverse — a fragile
// lint that fails on a legitimate refactor — costs a red required check for
// no safety at all.

/** Blank comments, keep strings — SQL lives in them. Offsets preserved. */
export function stripComments(text) {
  return blank(text, { strings: false });
}

/** Blank comments and string interiors. Offsets preserved. */
export function stripCommentsAndStrings(text) {
  return blank(text, { strings: true });
}

function blank(text, { strings }) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      if (strings) {
        // Delimiters kept, interior blanked: offsets stay comparable and a
        // string can never masquerade as code.
        out += text[i] + " ".repeat(Math.max(0, stop - i - 2));
        if (stop - i >= 2) out += text[stop - 1];
      } else {
        out += text.slice(i, stop);
      }
      i = stop;
    } else if (two === "//" || two === "/*") {
      const end =
        two === "//" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : two === "//" ? end : end + 2;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** A TRUNCATE statement, in the spellings Postgres accepts. */
const TRUNCATE_SQL = /(?<![\w$])truncate\s+(?:table\b|only\b|["a-z_])/gi;

/**
 * The guard, awaited or returned so Jest observes it finishing.
 *
 * HORIZONTAL whitespace only after the keyword. `\s+` matched a newline, and
 * `return\n  assertConnectedToTestDatabase(p)` returns undefined —
 * automatic semicolon insertion ends the statement at the line break, so the
 * hook does not wait for the guard at all.
 */
const GUARD =
  /(?<![\w$])(?:await|return)[ \t]+(?:[\w$.]+\.)?assertConnectedToTestDatabase\s*\(/g;

const SETUP_HOOK = /(?<![\w$.])before(?:All|Each)\s*\(/g;

/**
 * Offsets of TRUNCATE statements in a spec with no usable guard call.
 *
 * "Usable" means: awaited or returned, lexically inside a setup hook, and
 * appearing before the first TRUNCATE. Execution semantics beyond that are
 * the runtime guard's job — see the note at the top of this section.
 */
export function unguardedTruncates(spec) {
  const code = stripComments(spec);
  const executable = stripCommentsAndStrings(spec);

  // A STRING THAT BEGINS WITH THE STATEMENT. `code` keeps strings because
  // the SQL lives in one, which also means prose like
  // `"does not TRUNCATE TABLE users"` would reject a safe spec — a false
  // positive on a required check. Requiring the string to start with the
  // statement separates the two without scanning for call sites.
  const truncates = [...code.matchAll(TRUNCATE_SQL)]
    .map((m) => m.index)
    .filter((at) => {
      const q = Math.max(
        code.lastIndexOf('"', at),
        code.lastIndexOf("'", at),
        code.lastIndexOf("`", at),
      );
      return q !== -1 && /^["'`]\s*$/.test(code.slice(q, at));
    });
  if (truncates.length === 0) return [];

  // EVERY candidate, not the first. One guard-shaped expression outside a
  // hook — in a helper, say — otherwise made the function report every
  // truncate as unguarded while a real guard sat in the hook below it.
  const usable = [...executable.matchAll(GUARD)]
    .map((m) => m.index)
    .filter((i) => inSetupHook(executable, i));
  if (usable.length === 0) return truncates;

  const guard = Math.min(...usable);

  // The guard has to come first. Within one hook that is the real ordering;
  // across hooks it is a conservative approximation, and erring toward
  // reporting is the right direction for a destructive operation.
  return truncates.filter((at) => guard >= at);
}

/** Is `index` lexically inside a `beforeAll` / `beforeEach` body? */
function inSetupHook(text, index) {
  for (const m of text.matchAll(SETUP_HOOK)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const c = text[i];
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") {
        depth -= 1;
        if (depth === 0) {
          if (index > open && index < i) return true;
          break;
        }
      }
    }
  }
  return false;
}
