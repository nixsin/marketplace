/**
 * The web image must declare every variable the contract requires.
 *
 * A Dockerfile stage inherits nothing across a `FROM`, and an image carries
 * no .env file — so anything the contract requires and the stage does not
 * declare is undefined the moment `assertBootEnv` runs. In `build` that
 * fails `next build`; in `prod` the container exits at boot.
 *
 * Both were real, not hypothetical. Wiring the check in broke the prod image
 * immediately: NEXT_PUBLIC_* had always been build-stage only, which also
 * meant next.config.ts derived the CSP's connect-src from a fallback on
 * every container start. Render injects the same values at runtime, so it
 * never bit — nothing in the image said so, and nothing checked.
 *
 * This is the mechanism that keeps them in step, for the same reason the
 * Terraform and ci.yml drift tests exist: a Dockerfile cannot import the
 * contract, so only a test can compare them.
 *
 * SCOPE, so this file does not grow into a Dockerfile parser. The
 * authoritative check is `docker-web-prod-boot`, which builds the real image
 * and boots it — with the contract enforced at boot, a variable missing from
 * the prod stage fails CI there regardless of what this test concludes. This
 * is the fast, local early warning in front of it, and it reads plain
 * declarations only: anything it cannot read confidently throws with an
 * explanation rather than being guessed at.
 *
 * The one assertion with no such backstop is "no contract secret is a build
 * ARG" — nothing else checks that — which is why the refusals matter most
 * there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACTS } from "../packages/config/src/env-contract.js";

const dockerfile = readFileSync(
  fileURLToPath(new URL("../apps/web/Dockerfile", import.meta.url)),
  "utf8",
);

/**
 * Join `\`-continued lines, so one instruction is one line.
 *
 * Docker treats a trailing backslash as a continuation, which means
 * `ARG \` on its own line followed by `SOURCEMAP_SIGNING_KEY=x` is a
 * perfectly valid build argument. Reading raw physical lines misses it
 * entirely — and the guard it evades is the one stopping a secret from
 * being baked into the image, so a formatting change nobody thought twice
 * about would silently disarm it.
 */
export function normalizeContinuations(source) {
  // Docker lets a file change its escape character with an `# escape=`
  // directive, which makes backslash ordinary and (typically) backtick the
  // continuation. This function implements the DEFAULT only, so an
  // unsupported directive is refused rather than silently mis-read: under a
  // backtick escape a continued `ARG` would join nothing and slip past the
  // secret guard entirely.
  const directive = /^[ \t]*#[ \t]*escape[ \t]*=[ \t]*(\S)/im.exec(source);
  if (directive && directive[1] !== "\\") {
    throw new Error(
      `Dockerfile sets a non-default escape character (${directive[1]}). ` +
        `This check implements the default backslash only — teach it the ` +
        `directive, or drop the directive.`,
    );
  }
  // Heredocs are refused for the same reason. Inside `RUN <<EOF ... EOF` the
  // body is shell text, not instructions, but every line here is matched
  // against the FROM and ARG/ENV patterns — so a heredoc containing
  // `ENV NEXT_PUBLIC_API_URL=...` would be counted as a declaration, and one
  // containing `FROM ... AS prod` would invent a stage that later unions
  // with the real one. Both are false passes.
  // Detected by the bare `<<` rather than by matching heredoc syntax. A
  // pattern precise enough to describe a heredoc is also precise enough to
  // miss one — delimiters may be quoted, hyphenated, or arbitrary — and each
  // miss is a false pass. Neither Dockerfile contains `<<` at all, so the
  // blunt test costs nothing and cannot be evaded.
  if (source.includes("<<")) {
    throw new Error(
      `Dockerfile uses a heredoc, whose body this check cannot tell from ` +
        `real instructions. Teach declaredByStage to skip heredoc bodies, ` +
        `or keep declarations out of them.`,
    );
  }

  // Comments are dropped BEFORE continuations are joined, which is Docker's
  // own order: a comment does not continue onto the next line, however it
  // ends. Joining first would let `# note \` swallow the instruction under
  // it -- and if that instruction were `ARG SOURCEMAP_SIGNING_KEY=...`, the
  // secret guard would never see it.
  const withoutComments = source
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*#/.test(line))
    .join("\n");

  return withoutComments.replace(/\\[ \t]*\r?\n[ \t]*/g, " ");
}

/**
 * Variable names declared by each build stage, keyed by stage name.
 *
 * Stage-aware on purpose. A file-wide grep would report a variable as
 * declared in `prod` because `build` happens to set it — which is precisely
 * the mistake this test exists to catch, since `prod` is its own `FROM` and
 * inherits none of it.
 */
export function declaredByStage(source) {
  const stages = {};
  let current = null;

  for (const line of normalizeContinuations(source).split("\n")) {
    const from = /^\s*FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      current = from[1] ?? null;
      if (current) stages[current] ??= { ARG: new Set(), ENV: new Set() };
      continue;
    }
    if (!current) continue;

    // ARG and ENV are tracked SEPARATELY, because they are not
    // interchangeable. An ARG is in scope for RUN instructions during the
    // build and is gone by the time the container starts; only ENV persists
    // into the running image. Counting them together would let a prod-stage
    // `ARG NAME=...` satisfy this test while `next start` still saw nothing.
    //
    // Only the name matters here — what the value is belongs to the
    // contract's own value rules, which run against a real environment
    // rather than against this text.
    const decl = /^\s*(ARG|ENV)\s+(.*)$/i.exec(line);
    if (!decl) continue;
    const kind = decl[1].toUpperCase();

    // REFUSE TO GUESS rather than tokenise a value we cannot read.
    //
    // Splitting on whitespace is only sound while no value CONTAINS
    // whitespace. Two constructs break that, and both read the same way:
    // `ENV NOTE="a NEXT_PUBLIC_API_URL=x"` and its unquoted equivalent
    // `ENV NOTE=a\ NEXT_PUBLIC_API_URL=x` each declare only NOTE, while a
    // naive split records NEXT_PUBLIC_API_URL as declared too — a false
    // pass, the one direction this test must never fail in.
    //
    // Reading them properly means implementing Docker's quoting rules,
    // which is a parser, and this repo has already learned what
    // hand-written parsers cost. So the ambiguous construct is rejected
    // with an explanation instead of being guessed at.
    const quotedWhitespace = /(["'])(?:(?!\1).)*\s(?:(?!\1).)*\1/.test(decl[2]);
    const escapedWhitespace = /\\\s/.test(decl[2]);
    if (quotedWhitespace || escapedWhitespace) {
      throw new Error(
        `apps/web/Dockerfile: cannot read \`${line.trim()}\` — a value ` +
          `containing whitespace (quoted or backslash-escaped) is ambiguous ` +
          `to this check. Split it into one declaration per line, or teach ` +
          `declaredByStage Docker's quoting rules.`,
      );
    }

    // Which of Docker's two forms this is, decided by the FIRST token only.
    //
    //   ENV A=1 B=2       key=value — several variables on one instruction
    //   ENV NAME a b=c    legacy    — ONE variable, everything after is value
    //   ARG NAME          no default, still declares NAME
    //
    // The first token settles it, exactly as Docker does. Reading `=` signs
    // anywhere on the line instead would take the legacy form's value apart
    // and record `b` as declared — a false pass on the same class the
    // refusals above exist to stop.
    const [firstToken] = decl[2].split(/\s+/);
    if (firstToken.includes("=")) {
      // Anchored to start-or-whitespace so an `=` inside a value (a query
      // string, say) is not mistaken for another declaration.
      for (const [, name] of decl[2].matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/gi)) {
        stages[current][kind].add(name);
      }
    } else {
      const bare = /^([A-Z][A-Z0-9_]*)\b/i.exec(firstToken);
      if (bare) stages[current][kind].add(bare[1]);
    }
  }
  return stages;
}

const stages = declaredByStage(dockerfile);
const wanted = CONTRACTS.web.map((rule) => rule.name);

// `build` runs `next build`, `prod` runs `next start`. next.config.ts is
// loaded — and therefore checked — by both.
//
// The two stages accept different instructions, and that asymmetry is the
// point. During the build an ARG is in scope for RUN, so either will do. At
// container start ARG is gone, so `prod` must use ENV.
const accepted = {
  build: (declared, name) => declared.ARG.has(name) || declared.ENV.has(name),
  prod: (declared, name) => declared.ENV.has(name),
};

for (const [stage, isDeclared] of Object.entries(accepted)) {
  test(`the ${stage} stage declares every web contract variable`, () => {
    const declared = stages[stage];
    assert.ok(declared, `no stage named ${stage} in apps/web/Dockerfile`);

    const missing = wanted.filter((name) => !isDeclared(declared, name));
    assert.deepEqual(
      missing,
      [],
      `apps/web/Dockerfile's ${stage} stage never declares: ${missing.join(", ")}. ` +
        (stage === "prod"
          ? `ENV specifically — an ARG does not survive into the running container.`
          : `An image has no .env file, so these are undefined when assertBootEnv runs.`),
    );
  });
}

test("no contract secret is a build ARG", () => {
  // A build argument is recorded in the image's history and readable by
  // anyone who can pull it. Secrets must arrive at runtime, which for this
  // repo means a Render env group.
  //
  // Checked across BOTH contracts, not just the web one: an API secret
  // pasted into this Dockerfile would be baked in exactly the same way, and
  // whichever app declares it, it is still a secret.
  const secrets = Object.values(CONTRACTS)
    .flat()
    .filter((rule) => rule.secret)
    .map((rule) => rule.name);

  for (const name of secrets) {
    assert.ok(
      // Case-insensitive and indentation-tolerant: Dockerfile instructions
      // are both, so `arg SOURCEMAP_SIGNING_KEY` would otherwise slip past
      // while doing exactly the damage this guards against.
      // `ONBUILD ARG` counts. It defers the instruction to a child build
      // rather than declaring it here, but the name and its default are
      // still recorded in this image's metadata, and the child gets the
      // build argument this guard exists to forbid. Optional prefix rather
      // than a refusal, since matching it is no harder than rejecting it.
      !new RegExp(
        `^[ \\t]*(ONBUILD[ \\t]+)?arg[ \\t]+${name}\\b`,
        "im",
      ).test(normalizeContinuations(dockerfile)),
      `${name} is a build ARG in apps/web/Dockerfile — it would be baked into the image`,
    );
  }
});

// ---------------------------------------------------------------------
// The parser itself
// ---------------------------------------------------------------------

test("a continued declaration is read as one instruction", () => {
  // The evasion this exists to close: valid Dockerfile syntax that a
  // physical-line reader cannot see.
  const source = [
    "FROM node:26-alpine AS prod",
    "ARG \\",
    "  SOURCEMAP_SIGNING_KEY=leaked",
    "ENV \\",
    "  NEXT_PUBLIC_API_URL=https://example.test",
  ].join("\n");

  const stages = declaredByStage(source);
  assert.ok(
    stages.prod.ARG.has("SOURCEMAP_SIGNING_KEY"),
    "a continued ARG must still be seen — it is a real build argument",
  );
  assert.ok(stages.prod.ENV.has("NEXT_PUBLIC_API_URL"));
});

test("declarations are attributed to the stage that makes them", () => {
  const source = [
    "FROM node:26-alpine AS build",
    "ARG ONLY_IN_BUILD=1",
    "FROM node:26-alpine AS prod",
    "ENV ONLY_IN_PROD=2",
  ].join("\n");

  const stages = declaredByStage(source);
  assert.deepEqual([...stages.build.ARG], ["ONLY_IN_BUILD"]);
  assert.deepEqual([...stages.build.ENV], []);
  assert.deepEqual([...stages.prod.ENV], ["ONLY_IN_PROD"]);
  // The whole point of the stage split: `prod` inherits nothing.
  assert.ok(!stages.prod.ARG.has("ONLY_IN_BUILD"));
});

test("ARG and ENV are not conflated", () => {
  const source = ["FROM x AS prod", "ARG A=1", "ENV B=2"].join("\n");
  const stages = declaredByStage(source);
  assert.deepEqual([...stages.prod.ARG], ["A"]);
  assert.deepEqual([...stages.prod.ENV], ["B"]);
});

test("one ENV instruction can declare several variables", () => {
  // `ENV A=1 B=2` is a single valid instruction. Reading only the first
  // name would fail a Dockerfile whose variables are all present — a false
  // alarm, which erodes the test as surely as a missed one.
  const stages = declaredByStage(
    ["FROM x AS prod", "ENV A=1 B=2 C=3"].join("\n"),
  );
  assert.deepEqual([...stages.prod.ENV], ["A", "B", "C"]);
});

test("an = inside a value is not mistaken for a declaration", () => {
  const stages = declaredByStage(
    ["FROM x AS prod", "ENV URL=https://h/p?a=b&c=d"].join("\n"),
  );
  assert.deepEqual([...stages.prod.ENV], ["URL"]);
});

test("ARG with no default still declares the name", () => {
  const stages = declaredByStage(
    ["FROM x AS build", "ARG NEEDS_A_VALUE", "ENV LEGACY value"].join("\n"),
  );
  assert.ok(stages.build.ARG.has("NEEDS_A_VALUE"));
  assert.ok(stages.build.ENV.has("LEGACY"));
});

test("an ambiguous quoted value is refused, not guessed at", () => {
  // The false-pass this closes: NEXT_PUBLIC_API_URL appears only inside
  // NOTE's value, and a naive split would count it as declared.
  assert.throws(
    () =>
      declaredByStage(
        ['FROM x AS prod', 'ENV NOTE="a NEXT_PUBLIC_API_URL=x"'].join("\n"),
      ),
    /cannot read/,
    "a quoted value containing whitespace must fail loudly",
  );
});

test("ordinary quoted values are still read", () => {
  // The real Dockerfile uses ENV NAME="" — quoted, but unambiguous.
  const stages = declaredByStage(
    ['FROM x AS prod', 'ENV SOURCEMAP_SIGNING_KEY=""'].join("\n"),
  );
  assert.deepEqual([...stages.prod.ENV], ["SOURCEMAP_SIGNING_KEY"]);
});

test("FROM is recognised with a platform flag or indentation", () => {
  const stages = declaredByStage(
    [
      "FROM --platform=$BUILDPLATFORM node:26-alpine AS build",
      "ENV A=1",
      "  FROM node:26-alpine AS prod",
      "ENV B=2",
    ].join("\n"),
  );
  assert.ok(stages.build.ENV.has("A"), "platform flag broke stage detection");
  assert.ok(stages.prod.ENV.has("B"), "indented FROM broke stage detection");
});

test("a non-default escape directive is refused", () => {
  // Under a backtick escape, backslash is ordinary — so a continued
  // `ARG <secret>` would join nothing and walk straight past the secret
  // guard. Refuse the file rather than read it wrongly.
  assert.throws(
    () => normalizeContinuations("# escape=`\nFROM x AS prod\nARG A=1"),
    /non-default escape character/,
  );
});

test("the default escape directive is accepted", () => {
  assert.doesNotThrow(() =>
    normalizeContinuations("# escape=\\\nFROM x AS prod\nARG A=1"),
  );
});

test("escaped whitespace is refused, not guessed at", () => {
  // `ENV NOTE=a\ NEXT_PUBLIC_API_URL=x` declares only NOTE. Counting the
  // second name would report a required variable as declared when it is
  // really part of NOTE's value.
  assert.throws(
    () =>
      declaredByStage(
        ["FROM x AS prod", "ENV NOTE=a\\ NEXT_PUBLIC_API_URL=x"].join("\n"),
      ),
    /cannot read/,
  );
});

test("a comment ending in a backslash does not swallow the next instruction", () => {
  // Docker does not continue comments, however they end. Joining before
  // stripping them would hide this ARG from the secret guard entirely.
  const stages = declaredByStage(
    ["FROM x AS prod", "# note \\", "ARG SOURCEMAP_SIGNING_KEY=secret"].join(
      "\n",
    ),
  );
  assert.ok(
    stages.prod.ARG.has("SOURCEMAP_SIGNING_KEY"),
    "a comment must not be able to hide a build ARG",
  );
});

test("the legacy ENV form declares one variable, not tokens from its value", () => {
  // `ENV NOTE text NEXT_PUBLIC_API_URL=x` declares only NOTE. Recording the
  // second name would report a required variable as declared when it is
  // just part of NOTE's value.
  const stages = declaredByStage(
    ["FROM x AS prod", "ENV NOTE text NEXT_PUBLIC_API_URL=x"].join("\n"),
  );
  assert.deepEqual([...stages.prod.ENV], ["NOTE"]);
});

test("a heredoc is refused rather than read as instructions", () => {
  // Its body is shell text. Counting `ENV ...` inside one would report a
  // contract variable as declared when the image never sets it.
  assert.throws(
    () =>
      declaredByStage(
        [
          "FROM x AS prod",
          "RUN <<EOF",
          "ENV NEXT_PUBLIC_API_URL=not-a-declaration",
          "EOF",
        ].join("\n"),
      ),
    /heredoc/,
  );
});

test("a heredoc with an unusual delimiter is refused too", () => {
  // Quoted and hyphenated delimiters are valid. Detecting the bare `<<`
  // rather than the syntax is what makes this un-evadable.
  for (const opener of ["RUN <<'END-OF-FILE'", 'RUN <<"X.Y"', "RUN <<-EOF"]) {
    assert.throws(
      () => declaredByStage(["FROM x AS prod", opener, "EOF"].join("\n")),
      /heredoc/,
      `not refused: ${opener}`,
    );
  }
});

test("ONBUILD cannot smuggle a secret past the ARG guard", () => {
  // The one assertion in this file with no backstop, so an evasion here is
  // not caught anywhere else.
  const secrets = Object.values(CONTRACTS)
    .flat()
    .filter((rule) => rule.secret)
    .map((rule) => rule.name);
  assert.ok(secrets.length > 0, "no secrets declared — nothing to guard");

  const guard = (source, name) =>
    new RegExp(`^[ \\t]*(ONBUILD[ \\t]+)?arg[ \\t]+${name}\\b`, "im").test(
      normalizeContinuations(source),
    );

  const name = secrets[0];
  assert.ok(guard(`ONBUILD ARG ${name}=leaked`, name), "ONBUILD ARG evaded it");
  assert.ok(guard(`  onbuild   arg ${name}=leaked`, name), "case/spacing evaded it");
  assert.ok(guard(`ARG ${name}=leaked`, name), "the plain form must still match");
  assert.ok(!guard(`ENV ${name}=""`, name), "ENV is the permitted form");
});
