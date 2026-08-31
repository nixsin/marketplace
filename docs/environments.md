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

## There are no fallbacks, so every environment supplies its own values

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SITE_URL` used to default to localhost
whenever they were unset. That default was the app's worst configuration
failure: a deploy that lost `NEXT_PUBLIC_SITE_URL` published localhost
canonical URLs, hreflang alternates and OpenGraph images to real crawlers,
while every page still returned 200.

Both defaults are gone. `@medinstru/config/web` throws when either is unset,
in **every** environment — a default cannot tell "the developer has not
configured this yet" from "production lost this variable", and only one of
those was ever cheap to fix.

So each context now states its values, and there are exactly four places to
look:

| Context | Where the values come from |
|---|---|
| Your machine | `apps/web/.env` — `cp apps/web/.env.example apps/web/.env` |
| Dev stack | `docker-compose.yml`, in the web service's `environment:` |
| GitHub Actions | one workflow-level `env:` block in `ci.yml`, inherited by every job |
| Render | the dashboard, mirrored in `render.yaml` |

The `docker build` steps pass `--build-arg NEXT_PUBLIC_API_URL` with **no
`=value`**, which tells Docker to take it from the environment — so the
workflow-level block is the single source for the six CI steps that build or
boot the web app.

**`apps/web/Dockerfile` no longer defaults its ARGs either**, and that was the
subtler half. It declared `ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql`,
so a build that failed to pass the value did not produce an *empty* variable —
it produced a populated, plausible, wrong one, and no absence check would ever
have fired. The ARGs are now bare.

**`apps/api` deliberately does not use the throwing export.** It reads
`NEXT_PUBLIC_SITE_URL` directly, because it already handles absence better
than a throw would: `publicSiteUrl()` returns null, the outbound WhatsApp
message omits the link, and a warning naming the variable is logged — the
seller still gets the buyer's name, number and Ref. Refusing to boot the whole
API would trade a degraded message for no message. The hard failure still
exists, at the right layer: the contract marks the variable **required on
render**, so a real deploy refuses to start without it.

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
