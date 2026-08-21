# CI reference — every workflow, every job, and when it runs

A complete map of what runs, when, and what blocks a merge. Written because
"why did that check not run?" and "why is this red on `main` when the PR was
green?" both have precise answers that were previously spread across
`ci.yml`'s 1000+ lines and several CLAUDE.md sections.

For *why* individual jobs are designed the way they are, see CLAUDE.md. This
file answers **when**.

---

## The two things people get wrong

**1. A skipped check is not a failed check.** Most jobs are path-filtered:
a docs-only PR legitimately skips the entire test matrix. Skipped is fine to
merge past; failed is not. The `changes` job posts a comment on every PR
explaining which jobs will run and why — read that before wondering where a
check went.

**2. A PR's green run does not mean `main` is green.** Squash-merging creates
a **new commit**, and `push` fires a **separate CI run** for it. That run —
not the PR's — is what `autoDeployTrigger: checksPass` gates Render on. The
`comment-ci-result-on-pr` job posts that result back onto the merged PR, but
the manual check is:

```bash
gh run list --branch main --workflow ci.yml --limit 1
```

---

## Workflows: what triggers each one

| Workflow | Push to `main` | Pull request | Schedule (UTC) | Manual |
|---|---|---|---|---|
| **CI** (`ci.yml`) | ✅ | ✅ | — | ✅ (with `force_jobs`) |
| **CodeQL** (`codeql.yml`) | ✅ | ✅ | Mon 03:17 | — |
| **Dependency freshness** | ✅ | — | Mon 06:00 | ✅ |
| **Docker scan (scheduled)** | — | — | Mon 04:37 | ✅ |
| **Nightly production audit** | — | — | Daily 02:30 | ✅ (site override) |
| **PR reconciliation** | — | on PR *close* | Daily 07:00 | ✅ |
| **Rerun CI on PR comment** | — | on issue comment | — | — |

Three workflows exist **only** because a push-only trigger would miss things
that change without the code changing:

- **CodeQL** and **Docker scan (scheduled)** each re-check `main` weekly. Trivy
  scans against an external, time-varying CVE database — a newly disclosed
  vulnerability in an *unchanged* image would otherwise go unnoticed until
  the next Docker-touching PR.
- **Nightly production audit** checks the live site, which can break without
  any commit at all.

---

## `ci.yml` jobs — when each one runs

### Always, on every push and every PR

Never path-filtered, deliberately.

| Job | Display name | Why never filtered |
|---|---|---|
| `changes` | Detect changed paths | Produces the filters everything else reads |
| `lint` | Lint | Lints both apps in one command |
| `test-ci-scripts` | Test CI/reconciliation scripts | Covers workflow logic that its own PR's CI can't otherwise exercise |

### Path-filtered

Each runs when its filter matches. All except `mutation-test` can also be
force-run via `workflow_dispatch` — see the accepted ids below.

| Job | Display name | Runs when |
|---|---|---|
| `audit` | Dependency audit | `deps` |
| `test-api-unit` | API unit tests | `api` or `deps` |
| `test-api-e2e` | API e2e tests | `api` or `deps` |
| `test-web` | Web build + tests | `web` or `deps` |
| `perf-budget` | Web performance budget (Lighthouse) | `web` or `deps` |
| `test-e2e-web` | Web e2e (Playwright) | `api`, `web` or `deps` |
| `mutation-test` | Mutation testing (guards) | `api` or `web` — **not force-runnable** |
| `load-test` | API load test (autocannon) | `api` or `deps` |
| `docker-scan` | Docker image vulnerability scan | `docker` |
| `docker-smoke` | Docker dev stack smoke test | `docker` |
| `docker-web-prod-boot` | Docker web prod image boot test | `docker` |

`test-e2e-web` is filtered more widely than `test-web` on purpose: its
pagination assertion exercises real `apps/api` logic, so an API-only change
must run it too.

### Conditional on event, not on paths

| Job | Runs on |
|---|---|
| `ai-code-review` | Pull requests only. `needs: []` — starts immediately, in parallel with everything else |
| `ai-ci-results-review` | Pull requests, **after** the full job list. `always()` — a failure is the most useful case to review, not the least |
| `ai-failure-analysis` | Pull requests, only when a real failure occurred among its dependencies |
| `migrate` | **Push to `main` only.** Applies `prisma migrate deploy` against production |
| `comment-ci-result-on-pr` | **Push to `main` only.** Posts the post-merge result onto the originating PR, updating live as jobs finish |

---

## Path filters — what maps to what

| Filter | Matches |
|---|---|
| `deps` | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| `api` | `apps/api/**` |
| `web` | `apps/web/**`, `packages/**` |
| `docker` | `apps/api/**`, `apps/web/**`, `packages/**`, both Dockerfiles, `docker-compose.yml`, `.dockerignore`, `scripts/dev.sh`, plus the `deps` files |

Two non-obvious inclusions, both load-bearing:

- **`packages/**` is in `web` and `docker`.** `apps/web` depends on
  `@medinstru/config`, and `next.config.ts` imports it on the boot path — a
  config-only change can break the web build or the running container
  without touching a single file under `apps/web/`.
- **`scripts/dev.sh` specifically, not `scripts/**`.** A broad glob was
  rejected; a narrow one that excluded `dev.sh` would have skipped the one
  file `docker-smoke` actually runs.

**Workflow YAML is deliberately *not* in the `docker` filter.** Editing
`docker-scan`'s own steps does not trigger `docker-scan`. That gap is why the
force-run mechanism exists.

---

## Required checks (branch protection on `main`)

Eleven, plus one approving review:

```
Lint
Dependency audit
API unit tests
API e2e tests
Web build + tests
Web e2e (Playwright)
Web performance budget (Lighthouse)
Docker image vulnerability scan
Docker dev stack smoke test
Docker web prod image boot test
Analyze (javascript-typescript)      ← from codeql.yml
```

Check the live list rather than trusting this table:

```bash
gh api repos/nixsin/marketplace/branches/main/protection --jq '.required_status_checks.contexts'
```

**Not required, informational only:** `mutation-test`, `load-test`,
`test-ci-scripts`, `Dependency freshness`, `Docker image vulnerability scan
(scheduled)`, `Nightly production audit`. A red result on any of these is
worth reading, but it does not block a merge and does not gate a deploy.

**`enforce_admins` is `false`**, so `gh pr merge --admin` bypasses the
*review* requirement. With one active contributor that is the expected
pattern. It must never be used to bypass a genuinely **failing** required
check.

### What `perf-budget` actually enforces

It measures score, LCP and JS transfer size, but `PERF_BUDGET_ENFORCE` is set
to `js` in CI, so **only the deterministic JS budget blocks a merge**. LCP and
the overall score are measured, published to the dashboard, and tracked as a
trend — because on shared runners they swing enough that unmodified `main`
could fail its own required check.

---

## Forcing a job to run

The path filter is a static glob match and can miss genuine cross-boundary
effects. Two ways to override it:

```bash
gh workflow run ci.yml --ref <branch> -f force_jobs=docker-scan,test-web
```

Accepted ids: `audit`, `test-api-unit`, `test-api-e2e`, `test-web`,
`perf-budget`, `load-test`, `docker-scan`, `docker-smoke`,
`docker-web-prod-boot`, `test-e2e-web`.

`ai-ci-results-review` can also request a force-run itself when it judges a
skip wrong for a given diff. GitHub cannot change a job's `if:` mid-run, so
"force-run" always means starting a **separate** `workflow_dispatch` run — it
cannot resurrect the job that already skipped.

---

## Reruns

```bash
gh run rerun <run-id> --failed        # only the failed jobs
gh run rerun <run-id>                 # the whole run
gh run rerun --job <job-id>           # one job
```

A rerun cannot start while the run is still in progress. `/rerun-test` and
`pr-comment-rerun.yml` (a PR comment triggers a rerun) do the same thing.

**Before rerunning, decide whether the failure is real.** A `timeout` or
infrastructure error is worth a rerun; a genuine test failure is not. A
required check that fails post-merge is a fix-forward situation, not a rerun
one — unless you have established the cause is external.

---

## Jobs that cannot be tested before they merge

`migrate` and `comment-ci-result-on-pr` trigger **only** on `push` to `main`,
and several publish steps are gated on `github.event_name == 'push'`. Their
introducing PR's own CI structurally cannot exercise them.

This has caused real post-merge failures more than once — most often a job
publishing a badge without its own `permissions: contents: write` block,
since the repo default is read-only and an explicit `permissions:` block sets
every unlisted scope to `none`. Treat the first few live firings of any such
job as still being verified.
