# Where this code runs, and whether the env check can tell

`packages/config/src/env-contract.js` decides how strict to be from the
environment it thinks it is in. This file is the audit of that decision: every
context this repo's JavaScript actually executes in, what detection returns
there, and whether that is right.

Detection order and the reasoning behind it live in `detectEnvironment()`.
The short version: a platform marker first, then `APP_ENV`, then `test`, then
GitHub Actions, then any other CI, then a dev machine, then `unknown`.

## The matrix

| # | Where the code runs | Markers actually present | Detected as | Correct? |
|---|---|---|---|---|
| 1 | `pnpm dev` — web (`next dev`) | `NODE_ENV=development` | `localhost` | yes |
| 2 | `pnpm start:dev` — api (`nest start --watch`) | none | `localhost` | yes |
| 3 | Unit tests — Vitest (web) | `NODE_ENV=test`, `VITEST` | `test` | yes |
| 4 | Unit tests — Jest (api) | `NODE_ENV=test`, `JEST_WORKER_ID` | `test` | yes |
| 5 | API e2e — `pnpm test:e2e` | `NODE_ENV=test` (Jest sets it) | `test` | yes |
| 6 | Husky hooks, `scripts/*.mjs` by hand | none | `localhost` | yes |
| 7 | `CI=true pnpm install` on a Mac | `CI` | `ci-local` | yes |
| 8 | Dev stack — `./scripts/dev.sh` (compose) | none | `localhost` | yes, by inference |
| 9 | `pnpm build` / `pnpm start` on a Mac | `NODE_ENV=production` only | `unknown` | **see below** |
| 10 | Playwright e2e locally | `NODE_ENV=production` only | `unknown` | ⚠️ see below |
| 11 | Local `docker build --target prod` + run | `NODE_ENV=production` only | `unknown` | acceptable |
| 12 | GitHub Actions — lint, build, script jobs | `GITHUB_ACTIONS`, `CI` | `github-ci` | yes |
| 13 | GitHub Actions — test jobs | `NODE_ENV=test` + the above | `test` | yes — `test` must win |
| 14 | GitHub Actions — `docker-smoke` (compose) | none | `localhost` | yes, by inference |
| 15 | GitHub Actions — `docker-web-prod-boot` | `NODE_ENV=production` only | `unknown` | yes, deliberately |
| 16 | GitHub Actions — `perf-budget` (Lighthouse) | `GITHUB_ACTIONS`, `CI` | `github-ci` | yes |
| 17 | Render — Docker image build | `RENDER_GIT_COMMIT` (build ARG) | `render` | yes |
| 18 | Render — API container runtime | `RENDER=true` | `render` | yes |
| 19 | Render — web container runtime | `RENDER=true` | `render` | yes |
| 20 | The browser (client bundle) | n/a | never runs | n/a |

## The five findings behind that table

**Render splits into two processes that see different environments (17 vs
18/19).** Render injects `RENDER=true` into the running container, but hands a
Docker *build* nothing unless the Dockerfile declares an `ARG` for it — and
`apps/web/Dockerfile` declares one for `RENDER_GIT_COMMIT`, not for `RENDER`.
So the build sees only `RENDER_GIT_COMMIT` and the runtime sees only `RENDER`.
`isRenderDeploy()` accepts either, which is the only way to cover both. The
build-time half is the one that matters most: `NEXT_PUBLIC_*` values are
inlined into the client bundle then and cannot be corrected afterwards.

**Containers do not inherit the runner's identity (14).** Compose forwards
neither `CI` nor `GITHUB_ACTIONS`, so the dev stack running inside GitHub
Actions is indistinguishable from one on a laptop. Both genuinely *are*
developer stacks, so inference gets the right answer — but for the wrong
reason, and only because nothing sets `NODE_ENV` there. The wiring change
declares `APP_ENV` in `docker-compose.yml` so it stops depending on that.

**`test` has to beat both CI branches (13).** A Jest or Vitest process on a
GitHub runner is a test run *and* a CI run simultaneously. The suites supply
their own fixtures, so `test` must win or every test job starts demanding real
configuration.

**`unknown` is a real state, not a fallback (9, 11, 15).** `next build` and
`next start` both set `NODE_ENV=production`, so a production-looking process
with no platform markers is genuinely ambiguous — it could be a laptop, or it
could be a deployment on a host this code has never heard of.

Every variable is still **required** there — one list is shared by every
environment — but the stricter *production value* rules do not apply, so a
localhost URL or a placeholder secret passes in `unknown` and fails on Render.
It warns every time, because "unrecognised, so we applied the weaker rules" is
the silent-failure shape this check exists to remove.

`docker-web-prod-boot` (15) is the case that proves it should stay permissive:
that job boots the real production image with no configuration at all, on
purpose, and asserts a genuine 200. Anything required there would fail a
required check for doing its job. Keying strictness on `NODE_ENV=production`
instead of on platform markers would do exactly that.

**Rows 9 and 10 land in `unknown` today**, and the wiring change fixes row 10
by declaring `APP_ENV` in `playwright.config.ts`. Row 9 stays: a bare
`pnpm build` on your own machine is genuinely ambiguous. A bare `pnpm build` on your own machine
lands in `unknown` and prints the hint. Either export `APP_ENV=localhost`, or
ignore it — it is a warning, never a failure.

## One variable list, shared by every environment

**Every environment declares every variable.** What differs between a laptop,
CI and production is the *value*, never which variables exist.

This replaced a per-environment severity table, and the reason is worth
keeping. That table let a variable be "required on Render, optional everywhere
else" — which sounds careful and means the variable is invisible in the four
environments where you would actually notice it missing. You find out on the
deploy. Declaring everything everywhere moves that discovery to the laptop,
which is the only place it is cheap.

### Absent and empty are different things

`process.env.FOO` is `undefined` when nobody wrote the variable down and `""`
when somebody wrote `FOO=`. So "deliberately off" and "forgotten" *are*
distinguishable, and the model rests on that:

| State | Meaning | Result |
|---|---|---|
| `undefined` | nobody declared it | **error** — this environment is incomplete |
| `""` | declared as off | a value, legal only where `emptyMeans` documents it |
| a value | | checked, plus any stricter rule for this environment |

An earlier version treated `""` as absent. That was wrong here: it threw away
the one signal that separates a decision from an oversight.

### Where the values live

Nothing is wired yet. This change adds the contract, the checker and this
document; the boot-time enforcement and the per-environment wiring follow in
separate changes, so that each can be reviewed and reverted on its own.

Today the contract is exercised by hand:

```bash
node scripts/check-env.mjs all
```

which reads `apps/api/.env` and `apps/web/.env` if they exist. The localhost
values themselves come from `@medinstru/config` — `DEV_API_URL`,
`DEV_SITE_URL`, `API_DEFAULT_PORT` — so that anything which can import
JavaScript shares one definition rather than repeating a literal.

Each wiring change adds its own row here as it lands: the dev stack, the CI
jobs, the Docker image, and Render.

### Seeing it

```bash
node scripts/check-env.mjs api --list
```

prints every variable, whether empty is legal, which are secret, and which
environments constrain the value further. `--show` prints the startup banner
without booting anything.

## The startup banner

Every service prints its environment and every variable's value as it starts —
on every boot, not only on failure. "What is this process actually configured
with" gets asked far more often than "is the configuration valid", and this
answers it in the first lines of the log with no shell on the box and no
guessing about which `.env` won.

```
┌──────────────────────────────────────────────────┐
│  API starting — environment: render              │
├──────────────────────────────────────────────────┤
│  DATABASE_URL             *** (61 chars)         │
│  JWT_SECRET               *** (44 chars)         │
│  PORT                     4000                   │
│  WHATSAPP_ACCESS_TOKEN    (empty)  ← delivery off│
└──────────────────────────────────────────────────┘
```

**A secret is never printed, not even partially.** A masked prefix looks
helpful and is not: it narrows a brute-force, and it is exactly the kind of
thing that gets pasted into a bug report. The length is shown because a
wrong-length secret is a real and common misconfiguration and a length alone
reveals nothing usable.

It prints **once per process** — Next loads `next.config.ts` several times
during a build, and a diagnostic repeated four times is one nobody reads.

## Overriding detection

```bash
APP_ENV=localhost pnpm build
```

`APP_ENV` narrows inference — it can state an environment nothing can detect —
but it does **not** beat a platform marker. `RENDER=true` is injected by the
platform and cannot be stale, while `APP_ENV` is set by a person and can be, so
one leftover `APP_ENV=localhost` would otherwise disable every production rule.
A contradiction between the two is reported as an error rather than resolved
silently. `APP_ENV=unknown` is not an assertion and never wins.

It accepts
`render`, `github-ci`, `ci-local`, `test`, `localhost`, `unknown`; anything
else is ignored rather than trusted, so a typo cannot silently disable the
check.

To ask "would this pass on Render?" without deploying:

```bash
node scripts/check-env.mjs all --env render
```

That checks the environment you have against the rules for an environment you
are not in — the question worth asking before a deploy, and the reason
`--env` exists separately from `APP_ENV`.
