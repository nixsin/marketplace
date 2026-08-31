# Where this code runs, and whether the env check can tell

`packages/config/src/env-contract.js` decides how strict to be from the
environment it thinks it is in. This file is the audit of that decision: every
context this repo's JavaScript actually executes in, what detection returns
there, and whether that is right.

Detection order and the reasoning behind it live in `detectEnvironment()`.
The short version: `APP_ENV` wins outright, then Render, then `test`, then
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
| 8 | Dev stack — `./scripts/dev.sh` (compose) | `APP_ENV=localhost` (declared) | `localhost` | yes, **declared** |
| 9 | `pnpm build` / `pnpm start` on a Mac | `NODE_ENV=production` only | `unknown` | **see below** |
| 10 | Playwright e2e locally | `APP_ENV=localhost` (declared) | `localhost` | yes, **declared** |
| 11 | Local `docker build --target prod` + run | `NODE_ENV=production` only | `unknown` | acceptable |
| 12 | GitHub Actions — lint, build, script jobs | `GITHUB_ACTIONS`, `CI` | `github-ci` | yes |
| 13 | GitHub Actions — test jobs | `NODE_ENV=test` + the above | `test` | yes — `test` must win |
| 14 | GitHub Actions — `docker-smoke` (compose) | `APP_ENV=localhost` (declared) | `localhost` | yes, **declared** |
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
developer stacks, so `APP_ENV=localhost` is declared in `docker-compose.yml`
rather than inferred twice from nothing.

**`test` has to beat both CI branches (13).** A Jest or Vitest process on a
GitHub runner is a test run *and* a CI run simultaneously. The suites supply
their own fixtures, so `test` must win or every test job starts demanding real
configuration.

**`unknown` is a real state, not a fallback (9, 11, 15).** `next build` and
`next start` both set `NODE_ENV=production`, so a production-looking process
with no platform markers is genuinely ambiguous — it could be a laptop, or it
could be a deployment on a host this code has never heard of. It is treated
permissively (nothing is required) but it **warns every time**, because
"unrecognised, so we assumed the most permissive rules" is precisely the
silent-failure shape the env check exists to remove.

`docker-web-prod-boot` (15) is the case that proves it should stay permissive:
that job boots the real production image with no configuration at all, on
purpose, and asserts a genuine 200. Anything required there would fail a
required check for doing its job. Keying strictness on `NODE_ENV=production`
instead of on platform markers would do exactly that.

**Row 9 is the one to fix locally.** A bare `pnpm build` on your own machine
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

| Context | Declares its values in |
|---|---|
| Your machine | `apps/api/.env`, `apps/web/.env` (copy the `.env.example` next to each) |
| Dev stack | `docker-compose.yml` |
| GitHub Actions | one workflow-level `env:` block in `ci.yml` |
| Vitest | `apps/web/vitest.config.ts` |
| Playwright | `apps/web/playwright.config.ts` |
| Docker image | `ARG`/`ENV` in `apps/web/Dockerfile` |
| Render | the dashboard, mirrored in `render.yaml` |

The localhost values themselves come from `@medinstru/config`
(`DEV_API_URL`, `DEV_SITE_URL`, `API_DEFAULT_PORT`) so the files that can
import JavaScript share one definition. **The four that cannot** — both
`.env.example` files, `docker-compose.yml` and `ci.yml` — are pinned to the
contract by `packages/config/src/env-example-drift.test.js`, which fails if a
variable is missing from any of them. That test is the enforcement; without it
the contract would be a claim about the code and a hope about the YAML.

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

`APP_ENV` beats every inference, including Render's markers. It accepts
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
