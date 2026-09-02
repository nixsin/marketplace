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
  const head = source.slice(0, source.indexOf("\njobs:"));
  return head.split("\n").filter((l) => l === "env:").length;
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
    const INLINE_KEY = new RegExp(`["']?${WATCHED_RE}["']?\\s*:`);
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
// A LINT over assertConnectedToTestDatabase's call sites, not a proof that
// it executes. The prevention is the guard itself: it asks Postgres
// `SELECT current_database()` and throws unless the name ends in `_test`.
// This catches the ways that call goes missing by accident — deleted,
// commented out, hidden in a string, moved after the TRUNCATE, lifted out
// of its hook, or scoped to a describe that does not contain the truncate.
//
// It lives here rather than inline in the test so the fixtures exercise the
// real function. While it was inline, every fixture tested a helper instead,
// and the covering rule itself could have been deleted with all of them
// still passing.

/** Blank comments, keep strings — SQL lives in them. Offsets preserved. */
export function stripComments(text) {
  return blank(text, { strings: false });
}

/** Blank comments and strings. Offsets preserved. */
export function stripCommentsAndStrings(text) {
  return blank(text, { strings: true });
}

/**
 * Can a `/` at `i` start a regex literal rather than a division?
 *
 * The standard heuristic: a regex may follow an operator, an opening
 * bracket, a comma, or the start of input — never a value. Good enough for
 * test files, and the consequence of getting it wrong is bounded: a
 * misjudged `/` blanks or keeps a little more text, and both directions are
 * covered by fixtures.
 */
function startsRegex(text, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = text[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    const upto = text.slice(0, j + 1);
    return (
      "(,=:[!&|?{};+-*%^~<>".includes(c) ||
      /(?:^|[\s(;{])return$/.test(upto) ||
      /(?:^|[\s(;{])(?:typeof|case|in|of|do|else|yield|await)$/.test(upto)
    );
  }
  return true;
}

function blank(text, { strings }) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    // A REGEX LITERAL, skipped whole. An apostrophe inside one — `/isn't/` —
    // otherwise opened a "string" that blanked everything up to the next
    // quote, which could erase a raw-SQL call token and make an unguarded
    // TRUNCATE disappear from this lint.
    if (text[i] === "/" && two !== "//" && two !== "/*" && startsRegex(text, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        j += 1;
      }
      const stop = Math.min(j + 1, text.length);
      // The interior is blanked in the executable view for the same reason a
      // string's is: `/await assertConnectedToTestDatabase\(/` would
      // otherwise be counted as a real guard call.
      if (strings) {
        out += text[i] + " ".repeat(Math.max(0, stop - i - 2));
        if (stop - i >= 2) out += text[stop - 1];
      } else {
        out += text.slice(i, stop);
      }
      i = stop;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      if (strings) {
        // DELIMITERS KEPT, interior blanked. Blanking the quotes too
        // destroyed the backticks of a tagged template, so
        // `describe.each\`table\`(name, cb)` stopped matching in this view
        // and its callback lost its scope. Keeping them also costs nothing:
        // an interior of spaces still cannot masquerade as code.
        out += text[i] + " ".repeat(Math.max(0, stop - i - 2));
        if (stop - i >= 2) out += text[stop - 1];
      } else {
        out += text.slice(i, stop);
      }
      i = stop;
    } else if (two === "//" || two === "/*") {
      const end =
        two === "//" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const stop =
        end === -1 ? text.length : two === "//" ? end : end + 2;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Every `describe` form Jest offers, as a scope opener. */
// Jest accepts the modifier on either side: `describe.only.each` and
// `describe.each` are both valid, and only one order was recognised — so a
// guard inside the unrecognised form had no scope and read as file-level.
const DESCRIBE =
  /(?<![\w$.])(?:x|f)?describe(?:\.(?:only|skip|todo))?(\.each)?(?:\.(?:only|skip|todo))?\s*(?:`|\()/g;

/**
 * The body extents of every `describe` in `text`.
 *
 * `describe.each` is the reason this is a function rather than a regex.
 * `describe.each(cases)(name, cb)` is TWO calls, and matching up to the
 * first `(` gave the extent of `cases` — so a guard inside the callback had
 * no enclosing scope, read as file-level, and covered truncates in sibling
 * and parent scopes.
 */
function describeExtents(text) {
  return callExtents(text, DESCRIBE);
}

/**
 * Body extents for a call pattern, stepping over an `each` table.
 *
 * Shared by `describe` and `it`/`test` because both take `.each`, and both
 * spell it as TWO calls — `it.each([1])('x %i', cb)`. Handling it only for
 * describe left an `it.each` callback outside every extent, so a truncate
 * inside one read as sitting in a bare describe body.
 */
function callExtents(text, pattern) {
  const out = [];
  for (const m of text.matchAll(pattern)) {
    let open = m.index + m[0].length - 1;

    // Step over the cases argument to the call that takes the callback.
    // BOTH forms: `describe.each([...])(name, cb)` and Jest's tagged table
    // `describe.each`a | b`(name, cb)`. Handling only the parenthesised one
    // left the tagged form scoped to its TABLE, so a guard in the callback
    // had no enclosing scope and read as file-level.
    if (m[1] === ".each" && (text[open] === "(" || text[open] === "`")) {
      const cases = closingIndex(text, open);
      if (cases === -1) continue;
      const next = text.indexOf("(", cases + 1);
      if (next === -1) continue;
      open = next;
    }

    const end = closingIndex(text, open);
    if (end !== -1) out.push({ start: open, end });
  }
  return out;
}

/** Index of the bracket or backtick closing the one at `open`, or -1. */
function closingIndex(text, open) {
  if (text[open] === "`") {
    let i = open + 1;
    while (i < text.length && text[i] !== "`") i += text[i] === "\\" ? 2 : 1;
    return i < text.length ? i : -1;
  }
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The innermost describe body containing `index`, or null. */
export function enclosingDescribe(text, index) {
  let best = null;
  for (const { start, end } of describeExtents(text)) {
    if (index > start && index < end && (best === null || start > best.start)) {
      best = { start, end };
    }
  }
  return best;
}
// `.` excluded as well as `[\w$]`: `suite.beforeAll(...)` is a method call,
// not Jest's global hook, and a guard inside one never runs as setup.
const SETUP_HOOK = /(?<![\w$.])before(All|Each)\s*\(/g;

/** `it` / `test`, including Jest's modifier and `each` forms. */
const TEST_BODY =
  /(?<![\w$.])(?:x|f)?(?:it|test)(?:\.(?:only|skip|todo|failing|concurrent))?(\.each)?(?:\.(?:only|skip|todo))?\s*(?:`|\()/g;

/**
 * Raw-SQL execution call sites — where a TRUNCATE is actually a statement.
 *
 * Scoped to the CALL, not to the word, because the two cannot be told apart
 * by what follows: `TRUNCATE users` is a real statement and `TRUNCATE in
 * input` is a test title, and both are the word followed by an identifier.
 * Widening the pattern to catch the first inevitably caught the second,
 * which would have failed a required check over an unrelated test name.
 */
const RAW_SQL_CALL = /\$(?:execute|query)Raw[A-Za-z]*\s*(?:`|\()/g;
const TRUNCATE_WORD = /(?<![\w$])truncate(?![\w$])/gi;

/**
 * A whole TRUNCATE statement, used only for SQL extracted into a variable.
 *
 * `'TRUNCATE TABLE t'` and `'TRUNCATE is not permitted'` both begin with the
 * word, so the target list is not the discriminator — what follows it is.
 * SQL permits RESTART / IDENTITY / CASCADE or the end; prose keeps going.
 */
const TARGET = String.raw`(?:"[^"]+"|[a-z_][\w$]*(?:\.[a-z_][\w$]*)?)`;
const SQL_STATEMENT = new RegExp(
  String.raw`^truncate\s+(?:table\s+|only\s+)?${TARGET}(?:\s*,\s*${TARGET})*` +
    String.raw`(?:\s+(?:restart|identity|continue|cascade|restrict))*\s*;?\s*$`,
  "i",
);

/** The innermost `pattern` call whose body contains `index`, or null. */
export function enclosingExtent(text, index, pattern) {
  let best = null;
  for (const m of text.matchAll(pattern)) {
    const open = m.index + m[0].length - 1;

    // A TAGGED TEMPLATE ends at its closing backtick, not a bracket.
    // RAW_SQL_CALL matches `$executeRaw` followed by a backtick, and the
    // bracket scan never opened an extent for it — so it returned null and
    // unguardedTruncates SKIPPED the statement entirely. Prisma's
    // $executeRaw is a tagged template in ordinary use, so that was the
    // common form going unchecked.
    if (text[open] === "`") {
      let i = open + 1;
      while (i < text.length && text[i] !== "`") i += text[i] === "\\" ? 2 : 1;
      if (index > open && index < i && (best === null || open > best.start)) {
        best = { start: open, end: i };
      }
      continue;
    }

    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const c = text[i];
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") {
        depth -= 1;
        if (depth === 0) {
          if (index > open && index < i && (best === null || open > best.start)) {
            best = { start: open, end: i };
          }
          break;
        }
      }
    }
  }
  return best;
}

/** "All", "Each", or null — the setup hook lexically containing `index`. */
export function hookKindAt(text, index) {
  let best = null;
  for (const m of text.matchAll(SETUP_HOOK)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const c = text[i];
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") {
        depth -= 1;
        if (depth === 0) {
          if (index > open && index < i) best = m[1];
          break;
        }
      }
    }
  }
  return best;
}

/**
 * Offsets of TRUNCATE statements with no guard call covering them.
 *
 * A guard covers a truncate when it is before it, inside a setup hook, its
 * own describe scope contains the truncate, and it is not a beforeEach guard
 * against a beforeAll truncate — Jest runs every beforeAll first, whatever
 * the file order.
 */
export function unguardedTruncates(spec) {
  const code = stripComments(spec);
  const executable = stripCommentsAndStrings(spec);

  // The identifier boundary matters: `fakeAssertConnectedToTestDatabase()`
  // would otherwise satisfy the lint with the real guard removed.
  // AWAITED OR RETURNED. `beforeAll(() => { assertConnectedToTestDatabase(p); })`
  // lets Jest proceed before the database-name query resolves, which is the
  // race this guard exists to remove — so a bare call does not count.
  const guards = [
    ...executable.matchAll(
      /(?<![\w$])(await|return)\s+(?:[\w$.]+\.)?assertConnectedToTestDatabase\s*\(/g,
    ),
  ].map((m) => m.index);

  const unguarded = [];
  for (const m of code.matchAll(TRUNCATE_WORD)) {
    const at = m.index;

    // The statement lives inside the call's string argument, so the extent
    // must be found in `code` (strings kept). But the CALL ITSELF has to be
    // real code, or prose such as
    // `it('mentions $executeRawUnsafe("TRUNCATE users")')` reads as a
    // statement and fails a required check.
    //
    // So: locate the extent in `code`, then check the call token survives in
    // `executable`, where anything inside a string has been blanked to
    // spaces. Both strippers preserve offsets, so the indices line up.
    //
    // Testing the token rather than the whole extent is what keeps tagged
    // templates working: `$executeRaw` is real code while its backticked
    // body is blanked, so an extent-wide test would reject it.
    const call = enclosingExtent(code, at, RAW_SQL_CALL);
    if (call === null) {
      // NOT INSIDE A CALL. Two very different things look like this:
      //
      //   prose      it('rejects TRUNCATE in user input')
      //   extracted  const sql = 'TRUNCATE TABLE t'; ... execute(sql)
      //
      // The first is inert. The second is destructive and this lint cannot
      // follow the variable to its call site — so rather than skip both, a
      // SQL-SHAPED string outside any call is reported as an arrangement
      // that cannot be verified. Prose does not match those shapes.
      // The string must BEGIN with the statement. `const sql = 'TRUNCATE
      // users'` does; `it('rejects TRUNCATE in user input')` does not. That
      // is what separates extracted SQL from prose without classifying the
      // words after it — and it accepts every target form, quoted or not,
      // schema-qualified or not.
      const beforeQ = Math.max(
        code.lastIndexOf('"', at),
        code.lastIndexOf("'", at),
        code.lastIndexOf("`", at),
      );
      if (beforeQ === -1 || !/^["'`]\s*$/.test(code.slice(beforeQ, at))) continue;

      // ...and the REST of the string has to parse as the statement. Both
      // `'TRUNCATE TABLE t'` and `'TRUNCATE is not permitted'` begin with
      // the word; they diverge after the target list, where SQL allows only
      // RESTART / IDENTITY / CASCADE or the end.
      const quote = code[beforeQ];
      const closeQ = code.indexOf(quote, at);
      if (closeQ === -1) continue;
      if (SQL_STATEMENT.test(code.slice(at, closeQ))) unguarded.push(at);
      continue;
    }

    const token = code.lastIndexOf("$", call.start);
    if (token === -1 || /^\s*$/.test(executable.slice(token, token + 2))) {
      continue;
    }

    const truncateHook = hookKindAt(executable, at);

      // MUST RUN INSIDE A HOOK OR A TEST. A raw call sitting directly in a
      // describe body executes while the suite is being DEFINED — before any
      // beforeAll — so no setup-hook guard can precede it, whatever the file
      // order says.
      const inHook = hookKindAt(executable, at) !== null;
      const inTest = callExtents(executable, TEST_BODY).some(
        (e) => at > e.start && at < e.end,
      );
      if (!inHook && !inTest) {
        unguarded.push(at);
        continue;
      }

    const covered = guards.some((g) => {
      if (g >= at) return false;
      if (hookKindAt(executable, g) === null) return false;
      if (truncateHook === "All" && hookKindAt(executable, g) === "Each") {
        return false;
      }
      const scope = enclosingDescribe(executable, g);
      return scope === null || (at > scope.start && at < scope.end);
    });

    if (!covered) unguarded.push(at);
  }
  return unguarded;
}


/**
 * JavaScript constructs this lexer cannot read reliably.
 *
 * Same decision as `unreadableSpellings` makes for YAML, one language over:
 * `test-ci-scripts` runs without `pnpm install`, so no parser is available,
 * and hand-writing one produces a stream of near-misses rather than a
 * tokenizer. Each of these breaks a specific scan:
 *
 *   a bracket inside a regex     the extent scanners count it, so a
 *                                describe or hook never closes and its
 *                                guard reads as file-scoped
 *   a nested template inside     the tagged-template scan stops at the
 *   `${...}`                     first inner backtick, closing the SQL
 *                                extent before the statement
 *
 * Neither appears in this repo's specs. Reporting them keeps the failure
 * loud if one ever does, instead of silently dropping a destructive
 * statement from the lint.
 *
 * @returns {string[]} One description per construct; empty when clean.
 */
export function unlintableConstructs(spec) {
  const found = [];

  // Comments first: prose such as "cached (ETag/If-None-Match)" otherwise
  // reads as a regex literal spanning two slashes.
  const code = stripComments(spec);

  // Only an UNBALANCED bracket matters. `/^\\d{6}$/` has a matching pair, so
  // the extent scanners count both and cancel out; `/\\(/` and `/[(]/` do
  // not, and leave a scan hunting a close that never comes.
  //
  // Escapes are deliberately not stripped: the scanners count raw
  // characters, so an escaped bracket confuses them exactly as a literal one
  // does.
  for (const m of code.matchAll(
    /(?<![\w$)\]])\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+\//g,
  )) {
    if (unbalanced(m[0])) {
      found.push(`regex literal with an unbalanced bracket: ${m[0]}`);
    }
  }

  // A template interpolation containing another template: the tagged-template
  // scan stops at the first inner backtick, closing a SQL extent early.
  for (const m of code.matchAll(/\$\{[^}]*`/g)) {
    found.push(`nested template inside an interpolation: ${m[0]}`);
  }

  return found;
}

/** Do the brackets in `text` fail to pair up? */
function unbalanced(text) {
  const closers = { ")": "(", "}": "{", "]": "[" };
  const stack = [];
  for (const c of text) {
    if (c === "(" || c === "{" || c === "[") stack.push(c);
    else if (c in closers && stack.pop() !== closers[c]) return true;
  }
  return stack.length > 0;
}