# Operating this repo

This file is for an agent (Claude Code or otherwise) doing ongoing maintenance
on `nixsin/marketplace` — CI/CD, dependency upgrades, workflow changes, bug
fixes. For product/architecture context (data model, roles, roadmap), read
[TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md) first. For local dev setup and
testing commands, read [docs/development.md](./docs/development.md). This
file covers the parts neither of those does: how to work in this repo day
to day, and the non-obvious operational knowledge accumulated so far
(including full CI job descriptions).

For infrastructure — who provides DNS, hosting, storage and the CDN,
what each costs, what is cached where, and what changes if we migrate —
read [docs/infrastructure.md](./docs/infrastructure.md) and the
per-provider docs it indexes ([render.md](./docs/render.md),
[cloudflare.md](./docs/cloudflare.md), [godaddy.md](./docs/godaddy.md)).
Two dated items live there and are easy to miss until they bite: the
free-tier Postgres is **deleted** on 2026-09-14, and the domain
registration renews annually.

`apps/web/AGENTS.md` has a Next.js-version-specific note (this repo runs a
recent Next.js whose APIs may differ from training data) — read it before
touching anything under `apps/web`.

### Keep this file current

Every new architectural decision, workflow, policy, or piece of non-obvious
operational knowledge — the kind of thing that took real investigation to
figure out and would otherwise be re-derived from scratch next time — gets
added here as part of the same change, not as a follow-up. This instruction
itself belongs here for the same reason: it shouldn't need to be repeated.

## Git workflow — always the same shape

Never commit to `main`. Branch off it (`git pull --ff-only`, then `-b`),
verify locally (build/test/lint — see docs/development.md), `gh pr create`,
fix forward on the same branch if CI fails (never force-push over history
unless asked), `gh pr merge --squash`.

**Then check CI on `main` itself.** Squash-merge creates a brand-new commit
and `push` fires an entirely separate run — a different data point, not a
re-display of the PR's, and it is what gates Render's `autoDeployTrigger:
checksPass`. Confirmed live: a PR's Lighthouse run passed while the very next
push-to-main run on the identical squash-merged commit failed, because
`perf-budget` lacked `permissions: contents: write`. A required check failing
post-merge is fix-forward on a new branch, exactly like any other; "but the
PR was green" is not a reason to leave it.

`comment-ci-result-on-pr` posts that result onto the merged PR automatically.
Manual fallback: `gh run list --branch main --workflow ci.yml --limit 1` —
never the closed PR's Checks tab, which only shows `pull_request` runs from
while it was open.

Branch protection requires **11 checks** plus 1 approving review: Lint,
Dependency audit, API unit/e2e tests, Web build + tests, Web e2e
(Playwright), Lighthouse, Docker scan/smoke/prod-boot, and CodeQL. Treat that
as a snapshot — it has been stale before — and query the live list:

```bash
gh api repos/nixsin/marketplace/branches/main/protection --jq '{required_checks: .required_status_checks.contexts, required_reviews: .required_pull_request_reviews.required_approving_review_count}'
```

### The one hard rule: never merge past a failing required check

`enforce_admins` is `false`, so `--admin` bypasses the **review** gate. With
one active contributor that is the established, expected pattern, not a red
flag. It must never bypass a check that is actually **failing** — most of all
Lighthouse, which became required precisely because it was being bypassed. A
*skipped* check is fine to merge past; a *failed* one means investigate and
fix, or get explicit sign-off first. Never route around it silently.


## CI pipeline (`.github/workflows/ci.yml`)

**For a complete map of when every workflow and job runs — trigger matrix,
path-filter table, required checks, force-run and rerun mechanics — see
[docs/ci.md](./docs/ci.md).** That file answers *when*; this section covers
only the design decisions that are non-obvious enough to be re-derived
wrongly.

Split into small independent jobs on purpose: parallel runners, not one long
sequential job.

**`changes` — the path filter, and its two silent failure modes.** Runs
`dorny/paths-filter`, produces the `api`/`web`/`deps`/`docker` booleans, and
posts an edit-in-place PR comment (`<!-- ci-skip-logic-comment -->`)
explaining what will skip and why. Read that comment before wondering where
a check went.

Both of these cost real time to find, because a skipped job doesn't fail a
run — everything stays green while coverage silently stops:

- The filter step's `if:` must cover `push` as well as `pull_request`
  (`!= 'workflow_dispatch'`, never an enumerated allowlist). A regression
  here skipped every path-filtered job on every push to main for ~14 hours.
- It needs `base: ${{ github.ref }}` for `push`. Without it, a push *to* the
  default branch compares that commit against itself and finds an empty
  diff. `base` is ignored for `pull_request`, so setting it unconditionally
  is safe.

A "Verify the path filter actually ran" step guards both: it fails `changes`
outright if `steps.filter.outcome != 'success'` for any trigger except
`workflow_dispatch`. Deliberately independent of the `if:` itself — it
asserts the requirement rather than re-deriving it, so a future regression
in a *different* shape still gets caught.

`changes` is in `migrate`'s `needs:` explicitly, not just transitively.
Without that, a failing `changes` cascades its dependents to `skipped`, and
`skipped` passes `migrate`'s `!contains(needs.*.result, 'failure')` gate by
design — silently absorbing the one failure that must block a deploy.

**Why the `docker` filter covers both apps together.** Both images build off
a shared layer cache, and a workspace-root `pnpm install` in the `deps` stage
runs apps/api's `prisma generate` postinstall even for a web-only build — so
a web-looking change can still affect the API image. Verified before
narrowing it: both Dockerfiles use explicitly scoped `COPY` (no `COPY . .`),
so `scripts/` and `.github/` genuinely never enter either image. `scripts/dev.sh`
is listed individually rather than `scripts/**` because it is the one file
`docker-smoke` actually runs.

**Workflow YAML is deliberately not in the filter**, which is why the
force-run mechanism exists.

**`docker-scan` is path-filtered here but also runs weekly** in
`docker-scan-scheduled.yml`. Trivy checks an external, time-varying CVE
database, so filtering alone means a newly-disclosed CVE in an *unchanged*
image goes uncaught until the next Docker-touching PR. The scheduled run is
the actual design for CVE freshness; informational only.

**`ai-failure-analysis`** fetches failed job logs via raw
`gh api .../actions/jobs/$id/logs`, not `gh run view` — that gates on the
*whole run* completing, not the target job. A confirmed `gh` CLI limitation.
Its root-cause comments are a first guess, not ground truth.

**`migrate`** uses an explicit `needs.*.result` check rather than a plain
ref/event condition, so a *skipped* dependency doesn't block a deploy while
a *failed* one does.

## SEO rendering boundary

The locale home route deliberately reads `searchParams` on the server and is
therefore dynamically rendered. Its first catalogue page is still shared and
cached for 60 seconds through `unstable_cache`; this is the boundary that puts
real product names and links in the initial HTML without hitting Render's API
for every request. `ProductListing` receives the requested page as a server
prop rather than calling `useSearchParams`: putting that hook back inside its
static tree makes Next render only the nearest Suspense fallback during
prerendering, silently removing those links from crawler-visible HTML.

Locale root pages declare `en`/`hi` hreflang alternates because their UI copy
is translated. Product pages intentionally do not: the product data model has
one shared name/description, so alternates would claim translations that do
not exist. The sitemap follows the same rule, partitions into 24,000-product
shards behind `/sitemap.xml`, and propagates API failures so an outage cannot
be cached as a successful empty catalogue. Product JSON-LD contains only
known descriptive fields; do not add offers, availability, ratings, GTIN, or
condition until the product model contains truthful values for them.

## Docker prod-image boot test (`docker-web-prod-boot` job)

Exists because of a real production outage: `apps/web` crashed on every boot
with `Cannot find module './src/i18n/routing'`.

**Root cause, and the non-obvious part:** `next.config.ts` had gained local
imports, and `apps/web/Dockerfile`'s prod stage copied only `next.config.ts`
itself, never `apps/web/src`. **Next.js transpiles and loads `next.config.ts`
at container boot, not just at build time** — visible in the stack as
`next-config-ts/transpile-config.js` — so every boot hit `MODULE_NOT_FOUND`
and exited immediately. Not a degraded fallback: a hard crash, so Render's
load balancer had no healthy origin at all. Fixed by copying the whole
`apps/web/src` tree, not just the files `next.config.ts` imports today.

**Why no existing job caught it.** `docker-scan` builds the same `prod`
target but only scans it — it never runs the container. `docker-smoke` boots
a real stack, but via the `dev` target, which bind-mounts host source, so
`apps/web/src` is always present regardless of what the prod stage copies.
Neither could answer "was the image built with everything it needs".

**What the job does:** builds `--target prod`, runs the real container (no
bind mount), and polls for a genuine `200` — not `curl -f`, which passes on
a 3xx or 204. next-intl's locale routing makes a stray redirect a real
possibility, so the status code is compared exactly. Each iteration also
checks `docker inspect -f '{{.State.Running}}'` and bails early, because a
boot crash exits immediately rather than hanging. `docker run -d` succeeding
proves nothing on its own — it returns before the process can fail.

**The `set -e` trap, worth knowing before touching that loop.** GitHub
Actions runs steps under `bash -e`, and `status=$(curl ...)` propagates
curl's exit code through the assignment — so the *first* connection attempt
before the socket is open aborted the whole step, silently defeating the
retry loop on every run. Fixed with `|| true` **outside** the command
substitution: `-w '%{http_code}'` already prints `000` on connection
failure, so `|| echo 000` *inside* would produce `000000`.

**Scoped to `apps/web` only.** The root cause is specific to
`next.config.ts`'s transpile-at-boot behaviour. Add an equivalent for
`apps/api` only if a comparable failure is ever found there.

**No live API needed** — this checks that the container boots and serves,
not that product data renders. An unreachable API just yields the
fetch-error state, which still requires `next.config.ts` to have loaded.

## Badges and the metrics dashboard (`gh-pages` branch)

**Full reference: [docs/metrics.md](./docs/metrics.md)** — how
`publish-badge.sh` works, the history-append behaviour, the dashboard's own
tests, and the recipe for adding a metric.

The one thing that has bitten twice: **a job publishing a badge needs its own
`permissions: contents: write` block.** The repo default is read-only, and an
explicit `permissions:` block sets every unlisted scope to `none`. The
publish step only runs on `push` to `main`, so the introducing PR's own CI
cannot catch it either way.


## Web e2e testing (`test-e2e-web` job, Playwright)

**Full reference: [docs/testing.md](./docs/testing.md)** — what the suite
covers, why Chromium-only for now, the screenshot-baseline workflow, and
three real accessibility findings a clean axe-core run missed entirely.

Load-bearing points: it is **a required check**; it is path-filtered on
`api`, `web` *and* `deps`, because its pagination assertion exercises real
`apps/api` logic; and the screenshot baselines CI compares against are
**Linux-generated**, so regenerate them in the same environment CI uses
rather than committing local macOS PNGs.


## Security headers (`apps/web/next.config.ts`)

**Full reference: [docs/security-headers.md](./docs/security-headers.md)** —
every header, the measured trade-offs, and the deliberate gaps.

Two decisions worth knowing before editing them: the CSP is the **static,
no-nonce** form because nonces require every page to render dynamically,
which conflicts with keeping the shell prerenderable; and `connect-src` is
derived from `NEXT_PUBLIC_API_URL` rather than hardcoded, so an API move
updates it automatically. Header values live in `@medinstru/config`.


## Design system / theme (`apps/web/src/app/globals.css`)

**Full reference: [docs/design-system.md](./docs/design-system.md)** — the
palette, the two-tier token indirection dark mode depends on, the semantic
status colours, and the measured contrast results including two accepted
gaps.

The question that actually comes up: **only `apps/web/src/components/ui/**`
is shadcn-vendored.** Everything else under `components/` was hand-authored,
so editing it risks nothing on a future `shadcn add`. Even for vendored
files, direct edits are the expected workflow — the CLI never auto-updates
already-generated files.


## PR reconciliation (`pr-reconciliation.yml`)

Keeps every open PR targeting `main` in sync, event-driven (`pull_request:
closed`, merged-into-main guard), on a daily cron, and by hand. The cron
matters because drift accumulates faster than merges alone: a failed update
call, a PR opened between runs, drift from something other than a merge.

Three axes, all of which only **surface or retry** — nothing auto-resolves a
conflict or auto-approves a stuck run:

1. **Freshness** — attempts `update-branch`. Non-zero is expected when
   already current; not worth classifying GitHub's exact wording.
2. **Real conflicts** — `mergeStateStatus: DIRTY`. Flagged with an
   edit-in-place comment (`<!-- pr-reconciliation-conflict -->`) so it is
   not invisible in an Actions log, and updated to "resolved" rather than
   left stale.
3. **Stuck approval** — a run sitting at `action_required` over 24 hours
   (`<!-- pr-reconciliation-stuck-approval -->`).

`set +e` plus `pipefail` throughout: one PR's failure must not stop the rest.

**Decisions live in `scripts/lib/pr-reconciliation.mjs`, not inline bash** —
the workflow only gathers inputs and acts on outputs. Its tests run in
`test-ci-scripts` because this workflow never triggers on `pull_request`, so
a regression would otherwise reach `main` unnoticed and only surface at the
next close/schedule/dispatch.

That extraction exists because four review rounds found **six bugs, every
one the same shape: a failed or non-conclusive lookup treated as
conclusive.** Each was reproduced before being fixed:

1. `gh pr view`/`gh pr comment` need `--repo` — this job never runs
   `actions/checkout`, so `gh` cannot resolve a bare PR number.
2. `gh api --jq` takes exactly one string argument; jq's own `--arg` after
   it is a hard parse error. Pipe into a separate `jq --arg` instead.
3. Capture the lookup's exit status explicitly (`if var=$(cmd); then`) — a
   bare assignment makes failure and a clean result indistinguishable.
4. `mergeStateStatus: UNKNOWN` is a real enum value (mergeability still
   computing), not an error. Without its own branch it falls through to
   "resolved".
5. Marker-lookup pipelines need `pipefail` — `head -1` exits 0 on empty
   input whether that is a genuine zero-match or an upstream failure,
   producing a *duplicate* comment instead of an edit.
6. `pr_numbers=$(gh pr list ...)` failing looks identical to an empty list,
   making the scheduled safety net report success while doing nothing.

Comment bodies use `printf '%s\n%s'` (marker, message), never multi-line
bash literals inside `run: |` — a literal newline puts the continuation at
column 1 and breaks YAML block-scalar indentation.


## Post-merge CI result (`comment-ci-result-on-pr` job, in `ci.yml`)

Posts the push-to-main CI result onto the PR that produced it — a per-job
table plus a run link — updating live as the run progresses. Closes the gap
in the git workflow's step 6: a closed PR's Checks tab never shows the
separate run that `push` fired, so without this you have to already know to
go looking.

**`needs: [changes]` only**, so it starts within seconds rather than waiting
on the slowest job. The tradeoff is that it can no longer read
`needs.*.result` (that context only reflects jobs actually listed in
`needs:`), so it polls `GET /actions/runs/{run_id}/jobs` and matches on the
API's job **display name**, not the yaml id. Live progress requires the
polling anyway.

**Two independent limits, neither relying on the other**: the poll loop caps
at 90 iterations (30 min) and the job sets `timeout-minutes: 35`. A genuine
runner outage produces a "still waiting, worth checking directly" comment
instead of silently burning the timeout.

**Classify conclusions with a success allowlist, never a failure denylist.**
A completed job can conclude `timed_out`, `action_required`, `stale`,
`neutral`, or have a null conclusion. An early version checked only for
`failure`, so a timed-out job would have reported "✅ All checks passed".
All eight values plus null are covered in
`scripts/lib/ci-progress-comment.test.mjs`.

**Needs `actions: read`.** An explicit `permissions:` block sets every
unlisted scope to `none`, and this job calls `actions/*` endpoints — the
original version didn't, because it read results from the `needs.*` context
instead.

Decision logic lives in `scripts/lib/ci-progress-comment.mjs`
(`computeProgress`, `buildCommentBody`, `shouldStopPolling`,
`decideStatusLine`), called through thin `scripts/*.mjs` CLI wrappers so the
tests exercise the real code path rather than a parallel copy. Tested in
`test-ci-scripts`, which is necessary because this job only triggers on
`push` to `main` — a regression would otherwise ship unnoticed by its own PR.

Finds the originating PR via `GET /commits/{sha}/pulls`. **Capture and check
the exit status before inspecting the value** — a failed `gh api` prints raw
JSON error content to stdout, which reads as a value if you only check the
output. Edit-in-place (PATCH), or a long run leaves a dozen comments.

## AI code review gate (`ai-code-review` + `ai-ci-results-review` jobs)

**Full reference: [docs/ai-review.md](./docs/ai-review.md).** Two stateless
ChatGPT passes post real GitHub PR reviews; a `REQUEST_CHANGES` leaves
`required_pull_request_reviews` unsatisfied, so this is a genuine merge gate.
The rules below are the ones that must be loaded before you touch a PR.

**Never make an AI verdict able to satisfy the review requirement.** GitHub
blocks `GITHUB_TOKEN` from approving, deliberately. Do not route around it
with a PAT — a live review already caught and rejected that. `REQUEST_CHANGES`
posts as a real review; `APPROVE` always degrades to a plain comment, and a
human decides.

**Don't admin-bypass a `REQUEST_CHANGES` without addressing it.** It can be
wrong — it reviews a diff it has never seen before. If you are confident it
is wrong, say so in a PR comment with evidence and use your judgment. Do not
silently override.

**Do not wait on CI while an unaddressed review finding is sitting there.**
The two AI passes post as soon as they finish, minutes before the slow jobs
(Playwright, Docker, Lighthouse) do — so a review round is usually readable
long before the run goes green. Waiting for the whole run first wastes that
gap, and worse, the fixes will re-trigger everything anyway, so the run being
waited on is already superseded. Read the review the moment it lands, fix,
push, and let CI settle around the final commit. The only reason to wait is a
finding whose validity actually depends on a CI result — pass 2's job, which
by definition needs the results it is reviewing.

**Converging a review, in four rules.** The reviewer is stateless by design,
so it will repeat a finding forever unless you close the loop:

1. Verify every finding independently before acting — reproduce it. Real
   bugs are finite and converge; assumed ones do not.
2. A finding you investigated and disagree with goes in the override-decision
   log once, then you stop touching it. Pushing again hoping a stateless
   reviewer changes its mind is the actual loop risk.
3. Two rounds of the same finding with nothing new is converged. That is a
   human decision — bypass with the reasoning on record, or escalate.
4. **Re-review your own fix before pushing, and fix the whole class, not the
   cited instance.** Both have produced real rounds: a fix satisfying one
   finding introduced a worse bug, and a finding citing one file had three
   siblings. Batch a round's fixes into one push.

**Override-decision log.** One PR comment, marker `<!-- ai-review-override-log -->`,
edited in place — never a second comment. A table of finding / resolution /
Resolved-or-Overridden, ending in a `**Recommendation:**` line. Escape any
literal `|` inside a cell as `\|`. Update it in the same breath as the fix,
on every PR you are touching — this has been forgotten exactly once, by
batching it for later.


## Local pre-push AI review precheck (`.husky/pre-push`)

`scripts/ai-code-review-precheck.mjs` runs a reviewer on every `git push` —
a preview before spending a CI round-trip on a finding you could catch
yourself. It feeds the PR's existing override-decision log back in, so
something already disputed is not re-raised.

Same design as CI pass 1 (diff-only, same reasoning effort) with **one**
difference: it **fails open**. A missing `OPENAI_API_KEY`, a network error,
any failure to get a usable review — warn and allow the push. A real
`REQUEST_CHANGES` does block it; override with `git push --no-verify`. The
CI gate still fails closed regardless; this is convenience in front of it,
not a replacement. There is no local equivalent of pass 2 — no CI results
exist at push time.

**Both diff reviewers must report every finding at once**, ordered by
severity and prefixed `[High]`/`[Medium]`/`[Low]`, explicitly not holding
anything back for a later round. Without that instruction they return one
finding per round: PR #97 took five rounds of exactly one finding each, and
**all four already existed at round one**. Not applied to pass 2, whose job
is a narrow mechanical check rather than an open-ended hunt. Worth measuring
against the historical counts — #90: 18 blocking reviews, #94: 14, #97: 4.

**Reasoning effort is `medium`, matching pass 1** — reversing an earlier
latency-over-depth choice. A local pass *weaker* than the CI pass it
previews can only miss findings CI then raises, and each miss costs a full
round-trip (~4 min) to save ~20s. Override per-push with `PRECHECK_EFFORT`.

**The missing-key path is deliberately loud and never phrased as
"optional."** It once read as routine informational output and was scrolled
past for an entire session while CI kept raising findings it would have
caught. Every other skip path here is transient (no network, no diff, no
base ref); this one is a standing misconfiguration that disables the
precheck indefinitely. `PRECHECK_OPTOUT=1` silences it — an explicit
recorded choice rather than learning to ignore a warning. Both paths exit 0.

Reuses `review-verdict.mjs` and `override-decisions.mjs` unchanged, not
copies that could drift. The override-log fetch is best-effort: no PR yet
means empty context, the same fail-open default the CI jobs use.


## Dependabot

`.github/dependabot.yml`: weekly (Monday), grouped minor/patch for npm and
GitHub Actions, majors ungrouped, separate Docker entries per app (Dockerfiles
aren't pnpm-workspace-aware). Dependabot branches are **same-repo, not forks**
— you can `git checkout` and push fixes directly to them:

```bash
git fetch origin <dependabot-branch>
git checkout <dependabot-branch>
# fix, commit, push to the same branch — the existing PR picks it up
```

If a Dependabot PR goes stale (`mergeStateStatus: BEHIND` after another PR
merged to main), `pr-reconciliation.yml` (above) now handles this
automatically on every merge and once daily — `gh pr update-branch
<number>` is still the manual fallback if you need it sooner. A real
merge conflict (`mergeStateStatus: DIRTY`) can't be auto-fixed by either —
`pr-reconciliation.yml` will flag it with a PR comment, but resolving it
is still a `git checkout <branch> && git merge main`, fix conflicts,
push (same as any other Dependabot branch fix — see above, these are
same-repo branches).

**"2 workflows awaiting approval" on a Dependabot PR is not the same gate
as "Review required."** GitHub automatically requires a maintainer to
manually approve workflow runs from certain actors — Dependabot is one —
before the workflow is even allowed to *execute*, not just before merging;
it exists so a compromised or malicious dependency bump can't get CI to
run with secrets available without a human explicitly signing off first.
It commonly re-triggers on a new commit landing on the PR (e.g.
Dependabot's own "Merge branch 'main' into ..." auto-rebase commits).
Check `gh run list --branch <branch> --json conclusion --jq '.[0].conclusion'`
for `action_required` to confirm this is what's happening; approve from
the PR's Checks tab ("Approve workflows to run") when ready — this causes
CI to actually execute using repo secrets, so treat it with the same
care as any other secrets-using action, not as a rubber-stamp click.

**A `github_actions`-ecosystem Dependabot PR is often cheaper to re-do by hand
than to merge — but re-doing it does NOT skip the security review, it moves
it.** The reason to reach for this is the AI review, which fails closed on
those PRs via the empty-`OPENAI_API_KEY` path documented above, so every merge
costs an admin bypass with a posted justification; three such PRs
(#157/#158/#159) proposed **five lines between them**. Re-applying the bumps on
an ordinary branch gets a real AI review and one merge, and Dependabot closes
its own PRs once the versions match.

**Do not read that as a way around the `action_required` gate.** That gate
exists so a human consciously decides before a *newly trusted third-party
action version* runs with repository secrets, and recreating the same bump on
your own branch does not make the new version any safer — it just moves the
decision from a click to a diff review, where it still has to actually happen.
A raised review made exactly this objection about an earlier wording here, and
it was right. So the review is the precondition, not the paperwork:

- Read the release notes for **every** major being crossed, not just the
  target. Record what you found in the PR — for #165 that was checkout v7
  blocking fork-PR checkout under `pull_request_target`/`workflow_run` (grepped
  — this repo uses neither trigger), checkout v6 moving credentials to a
  separate file, and setup-node v7 dropping a dummy `NODE_AUTH_TOKEN` export.
- Confirm the tags resolve, via `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`.
- Prefer versions **already trusted elsewhere in this repo**. #165 was low-risk
  precisely because `main` had been running those three majors at 22, 16 and 13
  call sites for weeks; a bump to something genuinely new deserves more care
  than a sweep of stragglers onto the established version does.

The stronger control neither path gives you is SHA-pinning, which would make a
retagged release inert. Not adopted here — with Dependabot doing the bumps it
trades a real risk for constant lockfile-shaped churn — but that is the actual
fix if this repo ever handles anything worth stealing from CI.

Reserve the approve-and-merge path for bumps you cannot trivially reproduce,
which in practice means `npm_and_yarn` lockfile changes.

**Action pins drift silently, and Dependabot will not sweep them.** It opens a
bump against the versions present when it runs, so a job added afterwards keeps
whatever was current the day it was written, forever. Found five such
stragglers across two files while everything around them was already current --
including `mutation-test` on `pnpm/action-setup@v4`, which predates the pnpm 11
that `packageManager` pins. Grep for the whole class rather than the cited
line:

```bash
git grep -nE 'actions/checkout@v[1-6]|actions/setup-node@v[1-6]|pnpm/action-setup@v[1-5]' -- .github/
```

## The API test suite runs as ESM (NestJS 12)

NestJS 12 ships every `@nestjs/*` package as ESM with `"type": "module"`, so a
CommonJS Jest cannot load them at all. The migration is recorded here because
each step fails in a way that points somewhere else.

**The errors arrive in a fixed order, and only the last one is the real
problem.** `Must use import to load ES Module` → `transformIgnorePatterns`
looks like the fix and is not, because the refusal is based on the package's
own `type` field rather than its syntax. Adding `--experimental-vm-modules`
(which is what gates `vm.SourceTextModule`, and therefore Jest's whole ESM
path) then gets you to `ReferenceError: exports is not defined` — which is
ts-jest still *emitting* CommonJS.

**`module` must be forced in `tsconfig.spec.json`.** The base config's
`nodenext` picks ESM or CJS from the nearest `package.json`'s `type`, and
`apps/api` is not `"type": "module"` — so nodenext emits CJS no matter what
ts-jest's `useESM` says. `module: esnext` + `moduleResolution: bundler`
overrides it for tests only. Note the symmetry: this file previously forced
`commonjs` for the opposite reason (`@medinstru/config` is ESM and Jest was
CJS). That workaround is gone — running as ESM is what both dependencies
wanted. Making `apps/api` itself `"type": "module"` would also work and would
change what `nest build` emits for production; keeping it in the spec config
does not.

**`jest` is not a global under ESM.** Jest still injects `describe`/`it`/
`expect`, but the `jest` object itself must be `import { jest } from
'@jest/globals'` — 12 spec files needed it. Related and load-bearing: this
suite uses **no `jest.mock()` anywhere**, mocking through Nest's DI instead,
which is the single reason the migration was tractable. `jest.mock` has no
direct ESM equivalent (`unstable_mockModule` requires restructuring every call
site). Keep it that way.

**`__dirname` does not exist in ESM** — four files use `import.meta.dirname`
now, which needs Node 20.11+.

**The real Node floor is 22.22.3, not the 20.19 the release notes give.** That
figure is `@nestjs/core`'s (`engines: >=20`, with 20.19 required for
`require(esm)`); the toolchain around it is stricter — `@nestjs/schematics@12`
declares `>=22.12.0`, and the `@angular-devkit` packages `@nestjs/cli` pulls
want `^22.22.3 || ^24.15.0 || >=26.0.0` — so **22.22.3 is the binding number**,
being the highest of them. Nothing here runs below it (CI's `node-version: 22`
resolves to 22.23.x, Docker is 26), but the floor is the maximum across the
whole toolchain, not `@nestjs/core`'s own `engines`, which is the one the
release notes quote.

**Verified on Node 22, not just 24.** CI runs the API jobs on 22 and Jest's
`require(esm)` error text recommends 24.9+, which suggests a bump is needed.
It is not — that advice is for `require`ing ESM from CJS, and this suite is
ESM throughout. 370 unit and 39 e2e tests pass on 22, so `node-version` is
unchanged. Worth re-checking rather than assuming if the config changes again.

**`graphql` had to go DOWN, 17 → 16, and that fixed a live production
mismatch.** The ESM suite surfaced `Cannot require() ES Module graphql/
index.mjs in a cycle` — graphql 17 is ESM, and the CJS packages `graphql-tag`
and `graphql-type-json` `require()` it. But the real finding was underneath:
**`@apollo/server@5` peers to `^16.11.0` only**, so graphql 17 had been an
unmet peer in production the whole time. 16.14.2 satisfies every consumer
(`@nestjs/graphql@14`, `@nestjs/apollo@14`, Apollo Server, both CJS packages)
and is now allowlisted, since following `latest` would re-break Apollo.

**Two v12 behaviour changes that touch this app.** `playground` is gone from
`@nestjs/graphql` 14 — GraphiQL is the built-in IDE, so the option is
`graphiql`. And a class-validator rejection now surfaces a bare `Bad Request
Exception` rather than its own text. No behaviour change for the buyer, since
`categorizeInquiryError` matched neither string and both land in `unknown` —
but the server no longer says *which* field is wrong, so the inquiry form's
mirrored constraints are now the only thing that can tell a buyer what to fix.
Both are pinned by tests in `inquiries.e2e-spec.ts`.

**`@nestjs/schematics` is deliberately NOT a direct dependency any more.** At
v12 it peers to `typescript: >=6.0.0`, which this repo cannot satisfy —
TypeScript 6 deprecates `baseUrl` and turns on `strictPropertyInitialization`,
which fires on every `@InputType()` DTO field in the auth and inquiry layers.
Pinning it back to `^11.1.0` only trades that for a different unmet peer
(`chokidar ^4` via `@angular-devkit/core@19`). Dropping the direct dependency
resolves it completely: `@nestjs/cli` carries its own copy, `nest-cli.json`'s
`"collection": "@nestjs/schematics"` resolves through it, and `pnpm peers
check` is clean for the first time in this repo's history. Verified with a
real `nest generate service --dry-run`, not just `--help`. Re-add it only
alongside a TypeScript 6 migration.

## The products queries are bounded, and offset pagination is the weak one

`productsPaged(page:, pageSize:)` and `products(limit:)` are anonymous public
GraphQL args that reached Prisma's `take`/`skip` unclamped. Three concrete
consequences, all fixed: `pageSize: 0` made `totalPages` `Math.ceil(n / 0)` —
Infinity, not a serialisable Int; `pageSize: 1000000` fetched the whole
catalogue in one request; and `page` at a max GraphQL Int produced an offset
of **214,748,364,600** rows for Postgres to read and discard.

**The bound is on the OFFSET, not on `page`, and that choice is load-bearing.**
The legitimate page number grows with the catalogue — the sitemap walks it in
order — so a page cap would break sitemap generation at a catalogue size
nobody would connect back to the constant. `PRODUCTS_MAX_OFFSET` (100,000)
keeps the sitemap correct up to a 100,000-product catalogue, and `findPaged`
reports back the page it actually **served** rather than the one requested,
because echoing the request would tell a client it is looking at page
2,147,483,647 of a catalogue that stops long before it.

**The cap must be ALIGNED DOWN to a page boundary**, and a bare
`Math.min(skip, PRODUCTS_MAX_OFFSET)` is not. Whenever the ceiling is not
divisible by `pageSize` the capped offset lands mid-page: at `pageSize: 3` it
queries offset 100,000 while reporting page 33,334, which really begins at
99,999 — so that row is skipped and the page number describes rows the caller
did not get. `Math.floor(PRODUCTS_MAX_OFFSET / pageSize) * pageSize` fixes it.
The first version of this bound had the bug and its tests missed it because
they all used `pageSize: 100`, which divides evenly; the regression tests now
use 3, 7 and 33 and assert the property — `(page - 1) * pageSize === skip` —
rather than any particular number.

**A page past the ceiling is REJECTED, not clamped — and that asymmetry is
deliberate.** Page 0 and negative pages *are* clamped, because those are
malformed requests for a page that exists and rendering the first page is
friendlier than an error. A page beyond the offset ceiling is different: it
cannot be served at all, and answering it with different rows than were asked
for is a lie. Clamping mapped every such page to the same final one, so a
sequential consumer — the sitemap above all — would walk off the end and
receive that page's rows over and over with nothing reporting a problem.
Publishing a sitemap of duplicated products silently is worse than failing to
publish one.

`totalPages` is capped at what is reachable for the same reason, so the API
never advertises a page it would then reject. `totalCount` stays truthful —
the sitemap shards off that, not off `totalPages`.

**This bounds the damage; it does not fix offset pagination.** OFFSET is
unbounded-cost by construction. Deep walks belong on the cursor query
`products(cursor:)`, which has none.

**The open case, stated plainly, and tracked in
[#172](https://github.com/nixsin/marketplace/issues/172):** past 100,000
products the sitemap stops being able to finish the catalogue. It fails loudly
there rather than publishing duplicates, which is the right failure but still
a failure — the actual fix is cursor traversal in `loadSitemapProducts`, a
redesign rather than a limit. The awkward part is that cursor traversal is
inherently sequential while the current code fetches eight pages at once, so
it is not a drop-in swap. Today's catalogue is a few dozen products, so the
gap is real and three orders of magnitude away; revisit before the catalogue
approaches the ceiling, not after.

**`PRODUCTS_MAX_PAGE_SIZE` is 100 because `SITEMAP_API_PAGE_SIZE` is 100**,
and the API clamps *silently* — a short page, never an error. So raising the
sitemap's chunk past the API's ceiling would truncate every shard with nothing
failing anywhere.

They are **not** in the same place, and that is the point worth stating
precisely: `PRODUCTS_MAX_PAGE_SIZE` is exported from `@medinstru/config`, while
`SITEMAP_API_PAGE_SIZE` stays in `apps/web/src/lib/catalog-seo.ts` next to the
paging loop that uses it. What couples them is a test —
`apps/web/src/lib/catalog-seo.spec.ts` asserts the sitemap's value never
exceeds the API's — rather than a shared definition, because they are not the
same quantity: one is a ceiling, the other a chosen batch size beneath it.

## API coverage measures ALL of `src` — and the exclusions were the story

`apps/api`'s `collectCoverageFrom` was a hand-curated list of **10 files out
of 50**. The badge read 87.83%, which sounds like "the API is 87.83% covered"
and did not mean that.

**Auditing every excluded path is what found the real gap.** Three categories
came out of it, and only one was a genuine hole:

- **Correctly excluded, nothing to cover.** `inquiries/phone.ts` is a two-line
  re-export of `@medinstru/config` with zero executable statements;
  `auth/types/auth-token-payload.ts` is a type-only interface erased at
  compile. Jest never loads either. Not gaps.
- **Excluded and well tested anyway** — `inquiries.service.ts` at 96.85%,
  `whatsapp.service.ts` at 98.38%, `graphql-cache.ts` and
  `correlation.middleware.ts` at 100%. The riskiest code in the repo, none of
  it counted toward the number.
- **Excluded and genuinely untested** — `s3-blob-store.ts` (0%, the production
  storage path), `app.setup.ts` (0%), `correlation-exception.filter.ts` (0%).

**The one worth remembering: `storage/storage.module.ts` held `createBlobStore()`,
a real exported factory with three branches, at 0%.** The conventional
`!**/*.module.ts` exclusion — which looks obviously safe, since modules are
normally decorator shells — was hiding the function that decides whether
production writes to R2 or to a local directory no CDN serves. **A filename
pattern is not a safe proxy for "contains no logic."** That is the reason
`collectCoverageFrom` is now `["**/*.ts", "!**/*.spec.ts"]` and excludes
nothing else, `main.ts` and the module shells included: an exclusion is a
place things hide, and the cost of counting a few decorator statements is
lower than the cost of another `createBlobStore`.

**Chasing resolvers and models to 100% is theatre, and the numbers say so.**
`products.resolver.ts` reads 59% with every method tested. The "uncovered"
lines are decorator type-thunks — `@Query(() => Product)`,
`@Args('limit', { type: () => Int })` — arrow functions GraphQL invokes only
at schema-build time, which the e2e suite already does and a unit test never
will. The same applies to every `*.model.ts` and `*.input.ts` sitting at
71–87%. Read those numbers as "decorator-dense", not "untested", and spend
effort on files where the uncovered lines are statements you could actually
execute.

**Three ways to stop counting decorator thunks were tried, and none is worth
taking** — measured, not reasoned about, because each sounds like it should
work:

| Approach | Result |
|---|---|
| `/* istanbul ignore next */` above the decorator | **Worse**: 59.09% → 57.14%. The hint binds to the method node, not the decorator expression, so the thunk is still counted and the comment adds a line. |
| `coverageProvider: "v8"` | **Moves the artifact.** `products.resolver.ts` 59% → 100%, but `product.model.ts` 76% → 17%, because a class body that is entirely decorators reads as entirely unexecuted. |
| `coveragePathIgnorePatterns` | File-level only — the exact exclusion trap this whole section exists to describe. |

So the numbers stay as they are and get read correctly instead. If the v8
provider is ever adopted for another reason, expect the models and resolvers
to swap places rather than improve.

Widening the set moved the figure from 87.83% over ~140 statements to
**90.48% over 679** — genuinely higher while measuring nearly five times as
much. Getting there added **82 unit tests (370 → 452)**, of which **59** are
in eight new suites and the rest went into `products.service.spec.ts`,
and the ones that mattered were `s3-blob-store` (17 tests: every not-found
spelling providers disagree on, and that a real failure is rethrown rather
than laundered into "missing"), `app.setup` (the `/graphql` cache-control
patch, including that it fails closed once headers are sent), and
`products.service.findPaged`, which turned out to have **no test at all**
despite being the query behind the catalogue's numbered pagination.

**Nothing type-checks the spec files, and that is worth knowing before
trusting one.** `nest build` excludes them and ts-jest transpiles without
checking, so a spec can carry a real type error and still run green. Found
here via a review finding, confirmed with:

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.spec.json 2>&1 | grep -v TS2307
```

It reported genuine TS2345s in a fully passing suite — a response double
declared `setHeader` as returning `void` where Express returns the response,
so it was not actually assignable to the type it stood in for. Run this
whenever a test double is involved.

**`@jest/globals` is declared, and the type check is still not clean — those
are two separate problems.** The import is required (the `jest` object is not
a global under ESM) and was for a while a *phantom dependency*: imported by
twelve specs, declared nowhere, resolving only through pnpm's layout. That is
now fixed — it is a real devDependency, so the specs no longer depend on
incidental hoisting.

Declaring it does not make `tsc --noEmit` pass, and the reason is worth
knowing before anyone tries: it trades 17 resolution errors for **142**
`Argument of type X is not assignable to parameter of type 'never'`.
`@jest/globals`' `jest.fn()` is generic and infers `never` for arguments
unless given a type argument, so every bare `jest.fn()` followed by
`mockResolvedValue(x)` fails — 131 call sites, nearly all in specs that
predate the ESM migration. Fixing it means typing each mock
(`jest.fn<() => Promise<T>>()`); it is mechanical, it is not risky, and it is
its own change. Until then:

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.spec.json 2>&1 | grep -vE 'TS2345|TS2322|TS18046'
```

which still catches the class that matters — a test double that is not
assignable to the type it stands in for, which is what surfaced the
`setHeader` bug above.

## Shared configuration (`packages/config`, `@medinstru/config`)

Single source of truth for configuration **values**: the web app's runtime
values (`API_URL`, `SITE_URL`, `LOCALES`, `DEFAULT_LOCALE`), performance
budgets, HTTP cache and header values, cross-app wire contracts
(`CORRELATION_HEADERS`, the managed-image prefix), auth lifetimes, and every
AI automation's settings.

It exists because the JS budget was declared twice — `bundle-budget.spec.ts`
(curl-measured) and `perf-budget.mjs` (Lighthouse-measured) — kept in step
only by a comment saying they must move together. That is an invariant a
human has to remember and eventually won't.

**Plain JS plus a hand-written `index.d.ts`, not TypeScript**, because two
consumers have incompatible needs: `apps/web` compiles it and needs real
literal types (`LOCALES` feeds a `(typeof LOCALES)[number]` union next-intl's
routing depends on; `string[]` would silently widen it), while `scripts/*.mjs`
import it as plain Node ESM with no build step.

**Never put an API key value here** — only the *name* of the env var holding
it (`apiKeyEnv`). The package is committed, so a value would enter git
history permanently and be readable by every CI job. `resolveApiKey()` reads
by name at call time and its error text names only the variable, so a
misconfiguration cannot leak a partial key into a public log. A committed
test asserts no role carries a literal key.

**Tool-owned config files cannot move here** — `tsconfig.json`,
`eslint.config.mjs`, `next.config.ts`, `vitest.config.ts`,
`playwright.config.ts`, `postcss.config.mjs`, `prisma.config.ts`,
`components.json`, `jest-e2e.json` are each discovered by their tool at a
fixed path. Relocating one centralizes nothing; it breaks discovery. What
centralizes is the *values inside them*: `next.config.ts` importing `LOCALES`
is the pattern.

**Adding this package to an app takes four changes, three of which fail in
unrelated-looking ways:**

1. `deps` stage: `COPY packages/<name>/package.json` — install fails loudly.
2. `build` stage: `COPY packages packages` — the build fails on config load.
3. `prod` stage: `rm -rf` the path, then copy the real directory over pnpm's
   dangling workspace symlink — **builds clean, crashes at boot**. `COPY`
   onto an existing symlink follows it rather than replacing it.
4. `docker-compose.yml`: mount `./packages:/repo/packages` — otherwise the
   dev stack breaks, since the `dev` stage is `FROM deps` and bakes in no
   source.

Jest needs a test-only tsconfig too: the base sets `module: nodenext`, which
picks format from the *imported* package's `type`, so ESM survives into a
CommonJS test run and fails with `Unexpected token 'export'` — which looks
exactly like a file that was never transformed.


## Startup environment check, and why it is not a `prestart` hook

`packages/config/src/env-contract.js` holds the rules; the enforcement runs at
boot in `apps/api/src/main.ts` and `apps/web/next.config.ts`. Full matrix of
every context this code runs in and what detection returns there:
[docs/environments.md](./docs/environments.md).

**It exists because almost every variable here fails SILENTLY.**
`INQUIRY_IP_HASH_SECRET` missing does not error — the per-IP limit simply stops
running on an unauthenticated endpoint. `BLOB_PROVIDER` left at its default
makes production write uploads to a container directory no CDN serves.
`WHATSAPP_TEMPLATE_NAME` missing refuses every send. None of them fail loudly,
and several are only discoverable by noticing an absence weeks later.

**A `prestart` npm hook would be a silent no-op in production, which is the
whole reason the check lives in code.** Both prod images bypass npm scripts:
the API's `CMD` is `node dist/src/main.js` and the web's is `next start`. So a
lifecycle hook works perfectly on a laptop and never runs in the container —
the exact silent-skip shape this file already documents for path filters and
badge permissions. `next.config.ts` is the web hook because Next transpiles and
loads it at container **boot**, not only at build.

**`scripts/check-env.mjs` is the by-hand entry point, not the enforcement.**
Its `--env` flag checks the environment you *have* against the rules for one
you are *not in* — `node scripts/check-env.mjs all --env render` answers "would
this pass on Render?" from a laptop, which is the question worth asking before
a deploy. That is deliberately different from `APP_ENV`, which changes what you
*are*.

**Render is TWO environments that see different variables, and only one sees
`RENDER`.** `RENDER=true` is injected into the running container.
`RENDER_GIT_COMMIT` is passed into the Docker *build* via an explicit `ARG` —
Render hands a Docker build nothing else, so `RENDER` is absent while the image
is built. `isRenderDeploy()` accepts either. The build-time half matters most:
`NEXT_PUBLIC_*` are inlined into the client bundle then and cannot be corrected
afterwards. `apps/web/src/lib/site-url.ts` has gated on `RENDER_GIT_COMMIT`
since it was written; this generalises that precedent rather than inventing one.

**`unknown` is a named state, not a fallback.** `next build` and `next start`
both set `NODE_ENV=production`, so a production-looking process with no
platform markers is genuinely ambiguous. It is permissive — nothing is required
— but it warns every time, because "unrecognised, so we assumed the most
permissive rules" is the failure this check exists to remove. Do **not** make
strictness key on `NODE_ENV=production`: `docker-web-prod-boot` boots the real
production image with no configuration on purpose, and would fail a required
check for doing its job.

**Containers do not inherit the runner's identity.** Compose forwards neither
`CI` nor `GITHUB_ACTIONS`, so the dev stack inside GitHub Actions is
indistinguishable from one on a laptop. Both are developer stacks, so
`docker-compose.yml` declares `APP_ENV=localhost` rather than leaving it to be
inferred from nothing. Playwright's `webServer` does the same, because
`next build && next start` sets `NODE_ENV=production` on a developer machine.

**ONE VARIABLE LIST, SHARED BY EVERY ENVIRONMENT.** Every environment declares
every variable; what differs is the VALUE, never which variables exist. This
replaced a per-environment severity table, and the reason is worth keeping:
that table let a variable be "required on Render, optional everywhere else",
which sounds careful and means the variable is invisible in the four
environments where you would actually notice it missing — you find out on the
deploy. Declaring everything everywhere moves that discovery to the laptop.

**ABSENT AND EMPTY ARE DIFFERENT THINGS, and the model rests on it.**
`process.env.FOO` is `undefined` when nobody wrote the variable down and `""`
when somebody wrote `FOO=`. So `undefined` is always an error ("this
environment is incomplete"), while `""` is a *value* meaning "off" — legal only
where the rule's `emptyMeans` documents what off does. An earlier version of
this file said an empty string counts as ABSENT; that was right under the old
model and is wrong under this one, because it throws away the single signal
that separates a decision from an oversight.

**Per-environment rules are VALUE rules, not presence rules.** A localhost URL
is correct on a laptop and catastrophic in production; `BLOB_PROVIDER=local` is
correct locally and refused on Render. Those live in each rule's
`perEnvironment` map, so the variable list stays identical everywhere.

**The eight places that must declare values, and the test that holds them to
it.** `apps/api/.env`, `apps/web/.env`, `docker-compose.yml`, `ci.yml`'s
workflow-level `env:`, `vitest.config.ts`, `playwright.config.ts`,
`apps/web/Dockerfile` (BOTH stages — see below), and Render. The localhost
values come from `@medinstru/config` (`DEV_API_URL`, `DEV_SITE_URL`,
`API_DEFAULT_PORT`) for everything that can import JavaScript; the four that
cannot are pinned by `packages/config/src/env-example-drift.test.js`. Without
that test the contract is a claim about the code and a hope about the YAML.

**`apps/web/Dockerfile`'s prod stage is a fresh `FROM` and inherits NOTHING
from the build stage — not its ARGs, not its ENVs.** Re-declaring every
variable there is the only way the running container has them. Found by
building and booting the image, not by reading it: the container started,
printed a banner reporting every variable as `(not declared)`, failed the check
and exited. Same class as the 2026-08-18 outage — a prod stage missing
something the build stage had.

**`SOURCEMAP_SIGNING_KEY` is an `ENV`, never an `ARG`.** A build arg is
recorded in the image history, so a real key passed at build time is readable
by anyone who can pull the image; Docker's own linter says so. It is only
needed at runtime, and a runtime value overrides an image `ENV`.

**A malformed value is an error at every severity, including `optional`.**
Absence is frequently a deliberate, documented state — `REDIS_URL` blank in
`.env.example` is load-bearing. A value that is present and malformed never is.

**A startup banner prints on EVERY boot**, listing the detected environment and
every variable's value. "What is this process actually configured with" gets
asked far more often than "is the configuration valid". Secrets show as `***`
with a length and NEVER partially — a masked prefix narrows a brute-force and
is exactly what gets pasted into a bug report; a length alone reveals nothing
and catches the common wrong-length misconfiguration. It prints once per
process, because Next loads `next.config.ts` several times during a build and a
diagnostic repeated four times is one nobody reads.

**`node scripts/check-env.mjs <app> --list` prints the whole contract** —
every variable, whether empty is legal, which are secret, which environments
constrain the value further. Derived from the rules, never a second table.

**Messages never echo a secret's value.** Each rule carries a `secret` flag and
the formatter honours it — these strings land in Render logs and CI output.
Same discipline as `resolveApiKey()`, whose error text names only the variable.
A test asserts the property across the whole table rather than the two rules
someone thought to name.

**`dotenv` is imported in `main.ts` before the check, and that ordering was a
real bug.** `ConfigModule.forRoot()` is what loads `.env`, and it runs inside
`NestFactory.create()` — so a check placed before Nest boots saw an empty
environment and failed every local start despite a valid `.env` sitting there.
Found by running it, not by reading it.

**Two silent-skip bugs were found while wiring this up, both the same shape as
the path-filter regression above.** `test-ci-scripts` ran
`node --test packages/config/src/index.test.js` — a NAMED file, so a new suite
in that directory would have passed locally and never run in CI. It is a glob
now. And `apps/web/.gitignore` carried create-next-app's default `.env*`, which
swallowed `.env.example`: that file has existed on disk for a while, is
referenced from this document, and had **never once been committed**, so a
fresh clone got no record of what `apps/web` needs. `apps/api/.gitignore`
ignores only `.env` and never had the problem. Both are worth checking whenever
a file is added next to existing ones and "just works" locally.

### `API_URL` and `SITE_URL` now THROW on Render instead of falling back

`packages/config`'s localhost defaults are correct for local dev, CI and the
prod-image boot test — all three run unconfigured by design. They are never
correct on Render, and applying them there silently is this app's worst
configuration failure: a web service that lost `NEXT_PUBLIC_SITE_URL` serves
canonical URLs, hreflang alternates and OpenGraph images pointing at
`http://localhost:3000`, to real crawlers, with every page still returning 200.

**A localhost value is rejected, not just a missing one — and that is the half
that actually bites.** `apps/web/Dockerfile` declares
`ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql`, so a Render build that
fails to pass the value does not produce an *empty* variable, it produces a
populated, plausible, wrong one. A check for absence alone would miss every
real occurrence.

Throwing means a misconfigured deploy **fails to boot** rather than serving a
broken site, so Render marks the deploy failed and keeps the previous healthy
version live — strictly better than answering 200 with localhost links.

**Three layers, each catching what the others cannot**, and this is
intentional rather than redundant: `next.config.ts`'s `siteUrlProblem` (richest
message — private ranges, CGNAT, IPv4-mapped IPv6, embedded credentials, and
it never echoes the raw value), the config's own throw (covers every import
path, not just `next.config.ts`), and the contract table (reports everything at
once, and can be run against an environment you are not in). On a real Render
boot the config's throw usually fires first, since `next.config.ts` imports it.


## Buyer product inquiries (#91)

Shipped in three parts. This is part 2, **capture**: a buyer submits a question
on a product page and it lands in the `Inquiry` table. Part 1 (#150) added the
schema, `normalizeE164`/`isE164` and `Product.hasInquiryContact`; part 3 adds
delivery over WhatsApp's Cloud API. Nothing here sends anything to anyone.

**The confirmation says "recorded", and that is the whole design constraint.**
Copy that told the buyer the seller had their question was the single most
repeated review finding on the unsplit version of this work — three separate
rounds, two different wordings, both shown verbatim when delivery had failed.
A buyer who believes their message arrived waits for a reply that cannot come,
and does not retry. So `Inquiry` exposes **no `delivered` field** and
`submitInquiry` returns a bare `{ ok: true }`: there is nothing to branch on,
so no branch can claim the wrong thing. Three tests assert the absence — one on
the committed `schema.gql`, one on the API result's key set, one on the copy a
real browser renders. The delivery change has to add a real outcome before any
of that wording can change.

**The mutation is unauthenticated on purpose** (#91 story 3: a WhatsApp-shared
link must work on a cold visit), which makes it an abuse vector by
construction. Four limits, all counted from the `Inquiry` table rather than an
in-process counter that would reset on deploy and be per-instance: per phone,
per phone+product, per hashed IP, and an absolute per-seller cap. The two phone
limits are keyed on a value **the caller types**, so on their own they are
defeated by rotating E.164 numbers; the per-seller cap is the only one still
standing when a caller rotates both, and its rejection message is deliberately
vague so it cannot be used as a progress indicator. When login ships this must
NOT quietly become authenticated — record the session alongside the inquiry and
keep anonymous submission working.

**Check and insert run in one `Serializable` transaction**, and the product is
read *inside* it. Counting then inserting separately is a time-of-check /
time-of-use race, and a product read before the transaction opened could have
been reassigned in the gap — attributing an inquiry to the previous seller,
which once delivery exists means handing a buyer's name and phone to an
unrelated organisation. Serializable aborts rather than queues, so P2034 is
retried (three attempts); nothing else is, because retrying a deliberate
rate-limit refusal turns one rejection into three.

**Idempotency is enforced by the unique index, not by the lookup.** The client
generates one key per submission and reuses it on every retry — a lost response
is indistinguishable from a failed one, so a retry is expected rather than
exceptional. `create()`'s `findUnique` only avoids a round trip in the common
case; when two requests both pass it before either inserts, P2002 is caught and
**the winner's row is returned as the success**, because an error there would
tell a buyer their inquiry failed when it demonstrably succeeded. Only the e2e
test can prove this — it fires two identical submissions with `Promise.all` and
asserts one row and one id.

**An idempotency key is bound to its payload, and the client mints a new one
the moment the buyer edits.** Returning the stored row for a key without
checking what it holds loses real data silently, reproduced end to end against
a running server: submit a question, lose the response, correct the phone
number and reword the question, submit again — the API answers with the
*original* row's id and the confirmation reports the edited inquiry as
recorded. It never was. The same shape from the other direction: the DTO
permits an 8-character key, so two anonymous callers can pick the same one and
the second caller's lead vanishes. **The canonicalisation is shared, and it had to be**: the server binds the key
to the *normalised* phone, so with the web client fingerprinting the raw
string, reformatting `+919000000001` as `+91 90000 00001` read as an edit,
minted a fresh key, and wrote a second inquiry the server would have
recognised as the same one. `normalizeE164`/`isE164` therefore live in
`@medinstru/config` as a cross-app wire contract, with
`apps/api/src/inquiries/phone.ts` re-exporting them as the documented home.
`assertSameSubmission` compares the row's
own columns — no migration, and it compares what was actually written rather
than a hash of what we believed we wrote — over a **fixed field list**, not
the argument's keys. That last detail is not cosmetic: deriving the list from
the caller made `insertInquiry`'s wider args pull `ipHash` into the
comparison, so a genuine retry from a different address was rejected as an
edit. A test caught it. The client side keeps a buyer from ever meeting the
rejection: an edit really is a different submission, so it gets a new key.

**The per-seller cap is a known, accepted denial-of-service surface — see
[#152](https://github.com/nixsin/marketplace/issues/152), and do not quietly
raise or remove it.** It is shared across every buyer of that seller, so 12
rotating unverified numbers at the per-phone ceiling reach 60 and lock that
seller's buyers out for the rest of the rolling hour. It ships anyway because
the alternative is worse, not because it is fine: with no seller-wide cap an
anonymous endpoint writes unbounded rows, and after delivery ships that is
unbounded messages to a real person's phone. The real fix is a *non-forgeable*
control in front of the mutation — edge rate limiting on the true source
address, a Turnstile challenge, or verified phone ownership — and no
rearrangement of caller-supplied inputs substitutes for one.

The same issue covers a second surface worth knowing separately: **the limits
bound accepted rows, not requests.** A rejected attempt still opens a
transaction and runs up to four counts, and consumes no budget, so unbounded
database load is reachable without a single row being written. A nonexistent
`productId` is short-circuited by one indexed lookup before any transaction
opens — a real reduction, not a fix. Only a request-level control at the edge
bounds requests, which is why it is the first thing to do in #152 rather than
merely the cheapest.

**No seller can receive an inquiry until someone writes their number, and
nothing in the app writes it.** `Organization.whatsappNumber` is read by
`Product.hasInquiryContact` and by the delivery path; the only writer is the
seed, which deliberately writes unroutable `+999…`. So a perfectly configured
provider still sends every message to a number that cannot receive it. Until
seller onboarding exists, `pnpm --filter api seller:whatsapp` sets one — it
requires `--yes`, prints the blast radius first, and canonicalises through the
shared `normalizeE164`, because a number stored in any other shape makes the
seller read as uncontactable.

**Two env vars, documented in `apps/api/.env.example` by name only.**
`INQUIRY_IP_HASH_SECRET` keys the HMAC that stores a submitter's address as a
hash; **without it nothing breaks and the per-IP limit simply does not run.**
An unkeyed SHA-256 is not a fallback: IPv4's 2^32 space is small enough to
enumerate, so anyone holding the table recovers the address, and labelling such
a value "unkeyed" advertises the weakness without removing it. Storing nothing
is the honest option, and the limiter skips a null bucket by design.
`INQUIRY_TRUST_PROXY_HEADERS` must be exactly `"true"` before any header is
believed, and even then **only `cf-connecting-ip`** is — `resolveCallerIp`
returns null in every other case, including for `x-forwarded-for`, `req.ip`
and the socket. Each was tried and each is wrong in its own way. **`x-forwarded-for` is
APPENDED TO by proxies, not overwritten**, so a client sends their own chain,
the proxy adds to it, and the left-most entry — nominally "the originating
client" — stays attacker-controlled; reading it from the trusted end needs a
configured trusted-hop count nothing here has. `req.ip` inherits that exactly,
since Express derives it from the same header whenever app-level `trust proxy`
is on. `socket.remoteAddress` is unforgeable but behind Render's load balancer
it is the *balancer*, identical for every buyer — using it gave everyone one
shared bucket and locked out every caller for every seller once the limit was
reached. `cf-connecting-ip` alone is safe because Cloudflare **overwrites**
it, which holds only while every route to the origin goes through the edge —
so enabling the flag asserts the origin refuses non-proxied traffic, not
merely that a proxy exists.

**Nothing on the buyer path may carry the seller's number.** The resolver
returns `{ id, status, createdAt }` explicitly rather than spreading the row —
which would echo the buyer's own message and phone back to an anonymous caller
and hand out the previous submitter's `ipHash`. That assertion is written
against the **key set**, not a list of known-bad fields, because the row grows
a column every time this feature does.

**The rejection strings are a wire contract, not prose.**
`categorizeInquiryError` in `apps/web/src/lib/api.ts` routes the buyer's error
copy by matching substrings of the server's messages, so rewording one on the
API side silently re-categorises it. That happened: the idempotency-conflict
message read "already sent with different details" and the rate-limit branch
matched a bare `"already sent"`, so a key conflict told the buyer they had
sent too many inquiries recently — pointing them at a wait that cannot help.
Both sides are now specific (`"already used"` vs `"already sent inquiries"`),
and a test asserts the conflict message contains neither of the rate-limit
phrases.

## Buyer inquiry delivery (#91, part 3)

Part 3 of three. Part 1 (#150) added the schema and phone validation, part 2
(#153) the capture path. This one hands a recorded inquiry to WhatsApp's Cloud
API and records what came back. **It does not tell the buyer**: the GraphQL
`Inquiry` still exposes no delivery field and the confirmation still says only
"recorded", which stays true either way. Surfacing the outcome is part 4,
alone, because the confirmation copy is the highest-risk part of this feature
by review history — three separate rounds on the unsplit version were copy
claiming more than the API knew.

**Business-initiated messages need a PRE-APPROVED TEMPLATE.** Free-form text
is only deliverable inside a 24-hour window the *recipient* opens by messaging
the business first, which never happens here because the marketplace always
speaks first. The first implementation sent `type: 'text'` and would have
failed every production send while passing every test. So
`WHATSAPP_TEMPLATE_NAME` is **required configuration**, not optional: unset
means sends are refused before the request, with the missing variable named,
rather than attempted and rejected one message at a time.
`WHATSAPP_ALLOW_FREE_FORM` is a deliberate opt-in for a known-open window, not
a fallback. Full template contract in [docs/whatsapp.md](./docs/whatsapp.md).

**The template-parameter flattener must never EXPAND the string.** It replaced
each newline run with `" · "` — three characters for one — so the DTO's
1000-character message could reach 1024 and be cut. Twelve line breaks was
enough, which makes a fourteen-line spec list an ordinary casualty rather than
a pathological one: the buyer's question lost its ending silently, after Meta
had accepted the message as valid. The separator is now a single space, and
the summary stays readable flattened because its own labels (`From:`,
`Product:`, `Ref:`, `Link:`) carry the structure.

The guard that was supposed to prevent this compared
`INQUIRY_MESSAGE_MAX_LENGTH` against `WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH` and
found them correctly ordered — while the expansion happened *between* them,
where a comparison of two constants cannot see it. It now runs real input
through the real function and asserts nothing was cut, which is the property
rather than a proxy for it. Truncation, where it still happens, is by **code
point**: `.slice()` counts UTF-16 code units and splits surrogate pairs, which
matters most for the product name, where a 200-character cap is ordinary and
device names carry CJK and symbols routinely.

**The recipient's number keeps its leading `+`.** Meta's send-messages guide
recommends it explicitly — "If the plus sign is omitted, your business phone
number's country calling code is prepended to the customer's phone number" —
and their canonical example sends `"to": "+16505551234"`. Stripping it would
risk misdelivery for every buyer whose country differs from the business
number's, which for an India-and-US marketplace is most of them. Raised once
as a High-severity finding claiming the opposite; checked against the
documentation rather than acted on, and recorded at the call site so it is not
"cleaned up" later.

**Two template parameters, not one.** `{{1}}` is the product/contact summary,
`{{2}}` the buyer's own words. A single combined parameter meant a near-limit
question lost its ending to the metadata in front of it — silently, after Meta
had accepted the message as valid. Within the summary the contact line comes
**first** and the product name is bounded, because parameters truncate from
the end and product names are unbounded `String` in the schema: a long enough
name pushed the buyer's phone number off entirely, so the seller received an
inquiry that looked answerable and was not.

**An outcome write is RETRIED, because the fallback leaves the row lying.**
When a send Meta accepted fails to be marked `SENT`, the row keeps
`status: PENDING` with no `providerMessageId` and no `failureReason` — which
is byte-identical to a row that was never attempted. The #151 sweep reads
exactly those columns, so it would re-send an already-delivered inquiry and
put it on the seller's phone twice, which is the one outcome this feature is
built to avoid. Such a write almost always fails transiently, so three
attempts convert most of them into rows that tell the truth. It cannot close
the window entirely — a genuinely dead database can record nothing — and that
residual is a requirement on the sweep rather than something a retry removes.

**Record first, then deliver, and delivery can never fail the mutation.** By
the time any delivery code runs the lead is saved, so every branch either
updates the row or logs and returns what it knows. Two paths are deliberately
asymmetric with what the database says: an accepted send whose status write
fails still returns SENT (Meta *did* accept it, and reporting otherwise invites
a retry that double-messages the seller), and a failed `markFailed` still
returns FAILED. Both log loudly for reconciliation — a stuck row is visible and
fixable, a duplicate message to a real person is not.

**The buyer-facing response exposes NO delivery state — `status` is gone.**
It shipped in the capture change, where it was harmless because every row was
`PENDING` and the field said nothing. Delivery turned it into a real outcome
still handed to an unauthenticated caller, so the API reported delivery while
this change claimed not to, and anyone could probe whether a given seller is
currently reachable — more than `Product.hasInquiryContact` already discloses.
`InquiryStatus` is no longer registered as a GraphQL enum either, so the state
machine is not published through introspection. Part 4 adds `delivered`: one
deliberate field meaning "the provider accepted it", not the internal states.

**An ambiguous outcome WRITES `failureReason` while leaving `status` PENDING.**
It previously wrote nothing, which made a row left pending by an ambiguous
send byte-identical to one left pending by a crash before the send — and the
recovery sweep both cases are parked for cannot function without telling them
apart. `providerMessageId` does not distinguish them, because an ambiguous
send never returns one; that was an error in this file's own earlier notes.
The three states a sweeper keys off are: `FAILED` (definite, safe to re-send),
`PENDING` with a `failureReason` (attempted, unknown — check the provider
first), `PENDING` with neither (never attempted).

**A 5xx from the provider is AMBIGUOUS too, not just a transport timeout.**
The asymmetry was stark before it was fixed: our own `AbortSignal` firing at
10s recorded "we do not know", while Meta's gateway timing out at 9s and
answering `504` recorded "definitely not sent" — the same physical situation,
opposite conclusion, and the FAILED one invites a retry that double-messages
the seller. 4xx stays definite, `429` included: those are Meta rejecting the
request outright, which is a real answer rather than an absence of one.

**Success is a property of the BODY, not the status line — outbound as well
as inbound.** A `200` carrying an `error` key is refused rather than recorded
`SENT`, the same discipline the edge-caching section above applies to this
API's own responses. Marking an inquiry `SENT` that was never accepted is the
highest-stakes error in this feature: once the buyer is told about delivery,
it becomes a person waiting for a reply that is not coming.

**An AMBIGUOUS outcome stays PENDING, never FAILED.** A timeout or dropped
connection means the request may have reached Meta and been accepted before the
response was lost. FAILED invites a retry that double-messages the seller;
PENDING says what is true — we do not know. Nothing resolves one today; that
needs Meta's delivery webhook keyed on `providerMessageId`, which is stored for
exactly that purpose (TODO in the code, tracked in
[#151](https://github.com/nixsin/marketplace/issues/151)).

**Delivery is gated on `InsertedInquiry.inserted`.** An idempotent retry
returns the stored row *without* sending. Without that flag the database
deduplicates perfectly and the seller is messaged twice anyway — the exact
failure idempotency exists to prevent, arriving through the back door. The
product snapshot travels back from the transaction with the row for the same
class of reason: re-reading it afterwards to find the seller's number would
reopen the reassignment gap, which once delivery exists means handing a
buyer's name and phone to an unrelated organisation.

**A `FAILED` row is never delivered by any later request**, even after the
cause is repaired, because `create()` returns an existing row without
delivering. Those are definite non-deliveries and safe to re-send by
construction — but doing it in the request path hands an attacker an
amplifier, since a duplicate deliberately consumes no rate-limit budget. It
belongs to the sweeper in #151, which we trigger and pace. That issue now
carries the state table the sweeper needs, which is the reason the
ambiguous/definite split was worth shipping here rather than deferring with
it.

**Three parked cases live in [#151](https://github.com/nixsin/marketplace/issues/151)**,
each with a `FIX(#151)` comment at the exact line. A crash between the commit
and the send strands a row no retry will ever deliver — every retry matches
the idempotency key and returns without sending, correct for a duplicate and
wrong for one never attempted; it needs the same PENDING sweep the ambiguous
case does, which `providerMessageId` can already distinguish. And the web
form remembers one key and one fingerprint, so reverting to earlier content
mints a third key. None are reachable, or barely so, today; none are fine.

**The seller's number is NORMALISED, not merely validated** — and the two
sides must stay symmetric. The buyer's number has been canonicalised since
part 2; the seller's was only checked with `isE164`, so a number stored as
`+91 98765 43210` — the exact format the buyer form advertises as an example
— made `Product.hasInquiryContact` report the seller uncontactable, hiding the
form, *and* failed the send if a direct caller submitted anyway. Silently: no
error to the seller, no error to anyone, they simply never hear from a buyer.
Both call sites now use `normalizeE164`, so "reachable" means the same thing
in both. Unreachable while the seed is the only writer of that column; it
becomes reachable the day seller onboarding ships.

**`sanitizeForLog` strips `\p{Cf}` as well as `\p{Cc}`.** Stripping only
control characters let FORMAT characters through — U+202E RIGHT-TO-LEFT
OVERRIDE among them, which visually reverses the rest of a line. The function
exists to stop provider text forging log entries, and a reordered line forges
one as effectively as an injected newline. Note the buyer's own text still
reaches the seller's WhatsApp with such characters intact; that is a separate,
undecided question.

**`sanitizeForLog` bounds provider text before it is logged**, not after.
Meta's `error.message` is external input: newlines let it forge log entries
that look like ours. The 500-character column truncation happens after the log
call, so it protects the wrong thing.

## Known gotchas (already solved once — don't re-derive)

**`prisma migrate dev` refuses to run — and wants to RESET — when the dev
database holds a migration record with no matching file.** Same family as the
`bundleId` drift below, one level up: `prisma migrate dev` on the abandoned
`feat/bulk-inquiry` branch left a row in `_prisma_migrations` named
`20260822051416_add_inquiry_bundle`, whose file was never committed. Prisma
compares applied *names* against `prisma/migrations/`, finds one it cannot
account for, and offers exactly one remedy: `migrate reset`, which drops the
whole dev database. Taking that offer would have wiped the local catalogue for
the second time this project has managed it.

The surgical fix, once you have confirmed the file genuinely does not exist
**and** the migration's effect is already reverted:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql "postgresql://postgres:postgres@127.0.0.1:5432/medinstru" \
  -c "DELETE FROM _prisma_migrations WHERE migration_name = '<orphan>'"
```

That is metadata only — verify the row count before and after (16 products
either side, in the real case). Never reach for `migrate reset` on a database
holding data you would have to re-seed.

**`beforeEach(() => mock.mockResolvedValue(x))` silently CALLS the mock after
every test.** Vitest (and Jest) treat a function returned from `beforeEach` as
a teardown callback, and `mockResolvedValue` returns the `MockInstance` — which
is itself a function. The concise arrow returns it, so the runner invokes it as
cleanup, with no arguments. Cost real time in `inquiry-form.spec.tsx`: it
produced a trailing `mock.calls` entry whose first argument is `undefined`
(papered over with `.filter(Boolean)` rather than understood), and then made a
test that installs a *throwing* implementation fail with that throw **after its
assertions had already passed** — reported with no assertion error at all,
which reads like the code under test throwing rather than the harness calling
the mock. Diagnosed by bisecting to a two-`describe` file: identical test,
passing without the `beforeEach` and failing with it. Always give these hooks a
block body:

```js
beforeEach(() => {
  submitInquiryMock.mockResolvedValue({ ok: true });
});
```

Grep for `beforeEach(() => [a-zA-Z_].*Mock\.` before assuming a mock-count
assertion is wrong about the code.

**`prisma migrate status` reports "Database schema is up to date!" while the
database has columns no committed migration ever created.** It compares
applied migration *names* against `prisma/migrations/`, not the actual schema,
so a `prisma migrate dev` run on a branch that was later abandoned leaves the
column behind permanently and reads as clean forever after. Hit this directly
(2026-08-22): the local dev `Inquiry` table carried a `bundleId text NOT NULL`
from the abandoned `feat/bulk-inquiry` fan-out work, so every inquiry submitted
through the running dev stack failed with `Null constraint violation on the
(not available)` — a message that names no column and reads like an
application bug. The API's own e2e suite passed the whole time, because
`medinstru_test` is migrated from the committed files and had no such column.
Diagnose by comparing the real table against the committed schema rather than
trusting `migrate status`:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql "postgresql://postgres:postgres@127.0.0.1:5432/medinstru" -c '\d "Inquiry"'
```

Confirm the column appears in no file under `apps/api/prisma/migrations/` and
in no committed `schema.prisma`, then `ALTER TABLE ... DROP COLUMN`. Worth
checking whenever local behaviour and CI disagree about a table this repo has
recently changed on more than one branch.

**Never run `apps/api`'s e2e suite via `docker compose exec api ...`
against this repo's persistent dev container — it silently runs against
the real dev database, not the test database, and can wipe real seed
data.** Hit this directly (2026-08-18, while building the `product(id)`
query for #92): ran `docker compose exec api pnpm exec jest --config
./test/jest-e2e.json products`, and the suite's `beforeEach` (`TRUNCATE
TABLE "Product", "License", "User", "Organization" RESTART IDENTITY
CASCADE`) wiped the local dev catalog, replacing it with the last test
file's own fixtures. Root cause, confirmed by reading the actual
mechanism rather than guessing: `test/jest-e2e.json`'s `setupFiles`
(`test/setup-env.ts`) runs `dotenv.config({ path: '.env.test' })`
unconditionally, on every invocation — but `docker-compose.yml` sets
`DATABASE_URL` for the `api` service as a real container-level
environment variable pointing at `medinstru` (the dev DB), which is
already present in `process.env` by the time Node starts. `dotenv`'s
`config()` never overrides an existing `process.env` value by default —
so `.env.test`'s own `DATABASE_URL` (`medinstru_test`) is silently
skipped, and the suite runs against dev regardless of which command
invokes jest (`pnpm test:e2e` has the identical exposure — this is not
about which npm script you use, it's about running inside this
specific, persistent container at all). Recovered by re-running
`prisma/seed.ts` (its own delete is scoped to its own seller, so also
manually deleted one stray leftover org/product by id that belonged to a
different test fixture and outlived the reseed). **Fix/safe pattern**:
run `apps/api` e2e tests natively on the host (`pnpm --filter api
test:e2e`, with the host's own `.env.test` pointing at a real, separate
`medinstru_test` database Postgres server it can actually reach) or in a
genuinely fresh process/container that never inherited `docker-
compose.yml`'s `DATABASE_URL` — never via `docker compose exec` against
the long-running dev container. If a container-exec invocation is ever
truly necessary, override `DATABASE_URL` explicitly at exec time
(`docker compose exec -e DATABASE_URL=<test-db-url> api ...`), which
takes precedence over the container's baked-in environment for that one
command — untested here, but follows directly from how env-var
precedence actually works.
**`pnpm deploy --legacy` leaves workspace dependencies as a DANGLING
SYMLINK in the deployed output — a prod image can build cleanly and still
crash on every boot.** Hit this directly while introducing
`@medinstru/config` (2026-08-19), and it reproduced the 2026-08-18
production outage's exact shape before merge rather than after. Three
distinct fixes were required in `apps/web/Dockerfile`, and each was found
only by actually building and running the image:

1. **`deps` stage** — `COPY packages/config/package.json` is needed or
   `pnpm install --frozen-lockfile` can't resolve the `workspace:*` link
   at all (fails outright, loudly — the easy one).
2. **`build` stage** — `COPY packages packages`, because Next transpiles
   and loads `next.config.ts` as the very first thing `next build` does,
   and it imports `@medinstru/config`. Without this: `Cannot find module
   '@medinstru/config'` inside `next-config-ts/transpile-config.js`.
3. **`prod` stage** — `COPY --from=build /repo/packages/config
   ./node_modules/@medinstru/config`. This is the non-obvious one.
   `pnpm deploy --prod --legacy /out` does *not* materialize workspace
   dependencies; it writes `node_modules/@medinstru/config` as a symlink
   to `../../../repo/packages/config`, a path that exists only in the
   build stage. Copying `/out/node_modules` alone therefore lands a
   **dangling symlink**, and the container crashes at boot with
   `MODULE_NOT_FOUND` — after logging `✓ Ready in 79ms`, exactly the
   "Ready then dead" pattern the `docker-web-prod-boot` job exists to
   catch. Verified by reproducing the crash, applying the fix, and
   re-running: real `200` on `/en` and `/hi`, all four security headers
   present (proof `next.config.ts` fully loaded rather than silently
   falling back).

   Two pnpm-side alternatives were tested directly and neither removes the
   need for step 3: `pnpm deploy` **without** `--legacy` fails outright,
   and adding `injectWorkspacePackages: true` to `pnpm-workspace.yaml`
   still emits a symlink rather than real files. Copying the real
   directory over the symlink's location is explicit and doesn't depend on
   whatever relative depth pnpm happens to generate.

**The `dev` Docker stage needs the shared package bind-mounted, and this
was caught by the local pre-push precheck rather than by CI** — worth
recording as the first real demonstration that the precheck earns its
latency. `apps/web/Dockerfile`'s `dev` stage is `FROM deps`, which copies
only `packages/config/package.json`; `docker-compose.yml`'s `web` service
bind-mounts `./apps/web` but originally not `./packages`. Net effect: the
dev container held a workspace symlink pointing at a directory containing
a manifest but no `src/index.js`, so `pnpm dev` would die on
`next.config.ts`'s import — failing `docker-smoke`, a **required** check.
The prod-image work (above) had been verified by actually booting the
container, but the dev path hadn't, and the two stages fail for different
reasons. Fixed by mounting `./packages:/repo/packages` rather than
`COPY`ing it, matching how `apps/web` itself is provided (the dev stage
deliberately bakes in no source, so shared-config edits hot-reload like
app edits). Verified by rebuilding the real dev stack: real `200` on
`/en`, and `@medinstru/config` resolving inside the running container.

**The `changes` path filter needs `packages/**` in both `web` and
`docker`** — added at the same time. `apps/web` depends on
`@medinstru/config` and its Dockerfile copies `packages/`, so a
config-only change can break the web build or the running container
without touching a single file under `apps/web/`. Without those filter
entries such a change would silently skip the web build, the web tests,
and all three Docker jobs — the same class of silent-skip bug this file
already documents for the `dorny/paths-filter` `if:`/`base:` regression.

**A local import added to `next.config.ts` can crash prod at boot, not
build — and a real production outage happened this exact way
(2026-08-18, `apps/web`, ~40 minutes, confirmed resolved by #86).**
`next.config.ts` gained real local imports (`src/lib/security-headers.ts`
for CSP/HSTS generation, `src/lib/config.ts` for centralized config)
across several merges. `apps/web/Dockerfile`'s prod stage only ever
copied `next.config.ts` itself into the final image — never
`apps/web/src`. The critical, non-obvious fact: Next.js transpiles and
loads `next.config.ts` at container **boot** (visible in a crash stack
as `next-config-ts/transpile-config.js`), not only at `next build` time
— so every single boot hit `Error: Cannot find module
'./src/lib/security-headers'` (`MODULE_NOT_FOUND`) and the container
exited immediately. Not a silent fallback (that only happens for a
*missing* `next.config.ts` file itself, already documented below) — a
present-but-broken-import is a hard crash. With the container exiting on
every boot, Render's load balancer had no healthy origin at all: total
outage, not degraded service. Confirmed via a real Render deploy log and
by reproducing the identical crash locally (`docker build --target prod`
+ `docker run` on the exact image, same stack trace).

**Neither existing CI job would have caught this** — `Web build + tests`
runs `pnpm build` against the full checked-out repo (`src/` always
present there); `Docker dev stack smoke test` uses `docker-compose.yml`'s
dev target, which bind-mounts full source. Neither ever builds *and
boots* the actual `prod` Dockerfile target the way Render does. Closed by
#88 — see the "Docker prod-image boot test (`docker-web-prod-boot` job)"
section above for the actual CI job: builds+boots the real prod image and
asserts a real `200`, not just "container started" (this container's own
logs printed "Ready" before crashing on the `next.config.ts` load, so
"did it start" alone wouldn't have caught it).

**Fix applied**: `apps/web/Dockerfile`'s prod stage now copies the whole
`apps/web/src` tree, not just the specific files `next.config.ts` happens
to import today — so a future `next.config.ts` import from anywhere else
under `src/` doesn't silently reintroduce this same class of outage.

**A real, live example of admin-bypassing a required check correctly**,
worth reading alongside "The one hard rule" section above: while
recovering from this outage, `perf-budget` (Lighthouse) failed twice in a
row on the hotfix PR (#86) — a PR that changes exactly one Dockerfile
`COPY` line, which cannot plausibly move frontend LCP. Both failures were
the same marginal `/hi?page=2` overage (2.6s vs. 2.5s budget) already
documented as shared-runner noise elsewhere in this file, and the exact
same route had already independently flaked on three *other* unrelated
PRs earlier the same session. Rather than unilaterally admin-bypassing
(this file's own hard rule: never do that without explicit sign-off),
explicit confirmation was obtained from the repo owner given the active
outage, and the reasoning was posted as a PR comment before merging —
matching the override-decision-log discipline this file already
establishes for AI review findings, applied here to a CI check override
instead.

**Multiple rapid merges can leave Render deploying a stale, still-broken
commit for longer than expected.** Four PRs merged within roughly 10
minutes during this same incident, each independently triggering
`autoDeployTrigger: checksPass`. Real evidence this caused a queue, not
just build latency: a Render log captured *after* the fix (#86) had
already merged still showed the crash citing `./src/i18n/routing` — an
import path from an *earlier* merge, superseded before #86 ever landed —
confirming Render was still working through older queued (and still
broken) commits rather than jumping straight to the latest fix. If a
deploy seems stuck after a fix has genuinely merged and gone green on
`main`, check the Render dashboard's Deploys tab for a backlog before
assuming the fix itself is wrong — a manual "Deploy latest commit" from
the dashboard skips the queue.

**`pnpm deploy --prod` run inside the workspace leaves it in production mode,
and the next command dies with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.**
Same error as the Docker baseline-regen flow below, different cause, so it is
worth naming separately: `pnpm --filter web deploy --prod --legacy /out` is a
perfectly reasonable way to check what actually lands in the production image
(it is how `shadcn` was confirmed to leave it), but it re-runs
`pnpm install --production` against the real workspace on the way. Every later
command then finds devDependencies missing, wants to purge and reinstall
`node_modules`, and cannot prompt from a non-TTY — so `pnpm lint:check` fails
with a stack trace that says nothing about dependencies.

Recovery is the same one line, and it is fast:

```bash
CI=true pnpm install
```

Verify with a real test run rather than a clean install exit code. If you only
need to know whether a package is in the prod install, reading
`package.json`'s `dependencies` is enough and costs nothing — reach for the
real deploy only when the mechanism itself is in question.

**Regenerating Playwright Linux baselines via Docker (bind-mounting the
full repo) leaves a stray `.pnpm-store/` at the repo root that corrupts
the HOST's `node_modules` with Linux-native binaries** — hit this twice
independently in the same session before writing it down. The Docker
command mounts the whole repo (`-v "$(pwd):/repo"`, required for pnpm
workspace symlinks to resolve) and runs `pnpm install` *inside* the Linux
container against that same bind-mounted directory — since it's the same
directory the host sees, native addons (`@swc/core`, `esbuild`, `@parcel/
watcher`, `unrs-resolver`) get rebuilt for Linux and overwrite the host's
macOS-native ones in place. Symptom: the next `git commit` on the host
fails husky's pre-commit hook with `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_
NO_TTY]` (pnpm's own dependency-status check detects the platform
mismatch and wants to purge+reinstall, but can't prompt non-interactively
inside a hook). Fix: `rm -rf .pnpm-store/` at the repo root, then
`CI=true pnpm install` from the host (the `CI=true` skips the interactive
confirmation prompt pnpm would otherwise block on) to rebuild
`node_modules` with correct macOS-native binaries. Verify recovery with a
real test run (`pnpm test`), not just a clean install exit code — confirm
the actual host toolchain (vitest, esbuild, etc.) works again before
continuing. Not yet worth engineering around (e.g. an isolated Docker
volume for `node_modules` instead of the bind mount) since this only
happens during the relatively rare Docker-based baseline-regen flow, not
routine development — but if it becomes routine, that's the fix.

**A CI job with no explicit `permissions:` block gets read-only access,
not read-write — this repo's `default_workflow_permissions` is `read`**
(confirmed via `gh api repos/nixsin/marketplace/actions/permissions/
workflow`). `test-api-unit` and `test-web` both declare `permissions:
contents: write` specifically for their badge-publish steps; `perf-budget`
didn't, and its badge-publish step to `gh-pages` failed with `403
Permission ... denied to github-actions[bot]` on every push-to-main run —
not flaky, not intermittent, a deterministic permission denial every
single time, discovered live when it broke a required check post-merge
(see the git workflow section's step 6). Fixed by adding the identical
`permissions: contents: write` block `test-web` already had. Grepped
every `publish-badge.sh` call site in `.github/workflows/` (3 total, all
in `ci.yml`) to confirm this was the only job missing it — if a new
badge-publishing job is ever added, it needs this block too; it will not
work by inheriting the repo default.

**This exact gap recurred on `test-e2e-web` (PR #62, 2026-08-17)** — when
the `accessibility` metric's "Publish accessibility badge" step was added
to that job, it didn't get this block either, for the same underlying
reason the grep-based check above didn't catch it in advance: the step
only runs `if: ... && github.event_name == 'push'`, so it's structurally
unexercised by the introducing PR's own `pull_request`-triggered CI run —
the exact same "untestable pre-merge" shape already documented for
`comment-ci-result-on-pr` and the `workflow_dispatch` force-run mechanism
elsewhere in this file. First real evidence was a live push-to-main run
failing with the identical `403 unable to access ... The requested URL
returned error: 403` after retrying 5 times with backoff (`publish-
badge.sh`'s own retry logic, which correctly can't help here since the
problem is a permission denial, not a push conflict). Confirms the
"Adding a new metric" recipe below needs this called out explicitly, not
left implicit in "same pattern as the three above" — added there too.

**Convention: prefix a PR's title with `[blocked]` when it's stuck on a
genuine upstream gap** (confirmed via direct verification, not just an
error message — see the entries below for what that verification looks
like), not merely pending review or CI. It's a quick visual signal on
the PR list that no action is expected on that PR until the upstream
gap closes — check the title before re-investigating one. Currently:
`[blocked] Bump eslint from 9.39.5 to 10.9.0` (#161). Rename with
`gh pr edit <number> --title "[blocked] <original title>"` — don't
touch the rest of the title. Remove the prefix once the underlying
blocker actually clears and the PR becomes a normal mergeable bump
again. **Keep `scripts/known-outdated-packages.txt` in sync with this
list** — that's what keeps `dependency-freshness.yml` from permanently
failing on packages nobody can currently fix; add a package's exact npm
name there in the same commit that marks its PR `[blocked]`, and remove
it there too the moment the prefix comes off.

**"In sync" means with the *blockers*, not with the PR numbers** — those
churn underneath you. Dependabot closes and reopens a bump every time a
new upstream version ships, so the PR carrying a blocked upgrade changes
identity repeatedly while the blocker itself sits still: #24, #25 and #27
are all closed and superseded, and `eslint` is now carried by #161 while
`typescript` and `@eslint/js` have no open PR at all right now. All three
packages stay in `known-outdated-packages.txt` regardless, because an
entry tracks an unfixable dependency, not a PR. A closed PR is therefore
never evidence a blocker cleared — re-check the upstream package.

**Every entry carries its reason inline** (`prisma  # \`latest\` is 8.0.0-rc.12`),
and `check-outdated.sh` strips it before matching. A bare package name cannot
be reviewed without cross-referencing this file, which is exactly how the two
drift apart; the reason is what lets a reader decide whether the entry is
still true without re-deriving it. Note the failure mode if that strip ever
regresses: the entry stops matching, the package reads as actionable, and the
check goes **red** — loud rather than silent, but a regression test covers it
anyway.

**Two things belong there, and a third looks like it does and does not.**
Upstream having shipped no compatible release is the original case (`eslint`,
`@eslint/js`, `typescript`). Upstream pointing `latest` at a *prerelease* is
the second: `prisma@latest` is `8.0.0-rc.12`, while `@prisma/client@latest` is
the stable `7.10.0` — and Prisma requires the CLI and client to match, so
following `latest` would put the CLI a whole major ahead of the client. The
stable line is on the `prev` tag. Both cases are outside our code and clear
only when someone else acts.

**An upgrade that is merely EXPENSIVE is not one of them** — it stays
actionable and the check stays red until it is done. NestJS 12 was that case,
and it is now done; see the section below for what it took.

**Where these entries say "don't re-investigate", they mean don't re-derive
the finding from scratch — they do NOT mean "never check again."** Every
one ends with the exact command and the exact upstream condition that
clears it, because a blocker note whose only instruction is "trust me" goes
stale silently and this one did. Run the stated check before concluding a
bump is still blocked; it is one command. If it now passes, the entry is
wrong and the fix is to delete it, not to work around it.

- **The `typescript` 5.9.3 → 7.x bump is blocked upstream — don't
  re-investigate, don't try to force it through.** PR #27 carried it and
  is now closed; Dependabot will reopen an equivalent. `typescript-eslint`
  does not support TypeScript 7 at all: `pnpm lint:check` fails outright
  with `typescript-eslint does not support TS 7.0`, and
  `typescript-eslint@latest` (checked directly via `npm view
  typescript-eslint@latest peerDependencies`) still declares `typescript:
  '>=4.8.4 <6.1.0'`. Also checked the `canary` dist-tag specifically
  (`npm view typescript-eslint@canary peerDependencies`) since `@latest`
  alone doesn't cover separately-tagged prereleases — re-checked
  2026-08-29 at `8.68.1-alpha.6`, which declares the identical range, so
  there is no newer or prerelease version that fixes this yet. Tracked
  upstream:
  [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
  Merging this bump would permanently break `lint` — a never-path-filtered,
  always-required check — for every future PR. Mark whatever PR currently
  carries it `[blocked]` and leave it unmerged; `typescript` stays in
  `scripts/known-outdated-packages.txt` in the meantime. Before
  attempting this bump again: re-check `typescript-eslint`'s current
  peer-dependency range for `typescript` — once it covers `7.x`, this
  becomes a normal bump like any other Dependabot PR.
- **PR #161 (`eslint` 9.39.5 → 10.9.0) is blocked upstream inside
  `eslint-config-next` — don't re-investigate, don't try to force it
  through.** `eslint-config-next` (this repo's `apps/web` lint config,
  `16.3.2` in the lockfile, `16.3.3` latest) pulls in
  `eslint-plugin-react` as a transitive dependency (`pnpm why
  eslint-plugin-react --filter web`), and that plugin crashes under ESLint
  10: `TypeError: Error while loading rule 'react/display-name':
  contextOrFilename.getFilename is not a function`, because the
  rule-context shape it expects was removed. Confirmed via both `npm view
  eslint-plugin-react@latest peerDependencies` (still `7.37.5`, `eslint:
  '^3 || ... || ^9.7'` — no `^10`) and its `next` dist-tag (`7.8.0-rc.0`,
  itself far older than `latest` and clearly abandoned — no active
  prerelease channel carries a fix yet). The actual fix exists only as an
  open, unmerged upstream PR:
  [eslint-plugin-react#4022](https://github.com/jsx-eslint/eslint-plugin-react/pull/4022)
  ("fix: complete ESLint 10 compatibility"), consolidating
  [#4018](https://github.com/jsx-eslint/eslint-plugin-react/issues/4018).
  Re-verified 2026-08-29: #4022 is still open, last updated 2026-08-22.

  **`typescript-eslint` is the obvious second suspect, and as of
  2026-08-29 it is NOT a blocker — confirm with the extractor below rather
  than re-deriving it by hand.** `apps/api` lints through it, so it would
  gate this bump if it lagged, but it does not:
  the version already in `pnpm-lock.yaml` (`8.67.0`) declares `eslint:
  '^8.57.0 || ^9.0.0 || ^10.0.0'`, as do `latest` (`8.68.0`) and canary
  (`8.68.1-alpha.6`). Support landed between `8.55.0` and `8.60.0`, so
  this repo has been clear on that front since well before the bump was
  attempted.

  **`eslint-plugin-react` is the blocker with a demonstrated crash, but it
  is NOT the only package holding this bump back — checked 2026-08-29, and
  the tempting "it's just the one plugin now" framing is wrong.** Three
  plugins in the tree cap their `eslint` peer below `10`, and every one of
  them arrives through `eslint-config-next` and is already at its latest
  published version: `eslint-plugin-react@7.37.5` (`^3 || ... || ^9.7`),
  `eslint-plugin-import@2.32.0` (`^2 || ... || ^9`) and
  `eslint-plugin-jsx-a11y@6.10.2` (`^3 || ... || ^9`). Only the first has
  a reproduced runtime failure and a known upstream fix; the other two are
  peer-range exclusions whose runtime behaviour under ESLint 10 was not
  tested, since the run dies on `react` first. Every other `eslint` peer
  in `pnpm-lock.yaml` is satisfied — check that claim with the extractor
  below rather than eyeballing it, and note that `>=8.0.0`, `>=9.0.0` and
  `*` all *do* admit `10.x`, which is easy to misread as a cap:

  ```bash
  awk '/^  [^ ]/{pkg=$0; sub(/^  /,"",pkg); sub(/:$/,"",pkg); insec=0}
       /^    peerDependencies:$/{insec=1; next}
       /^    [a-zA-Z]/{insec=0}
       insec && /^      eslint:/{r=$0; sub(/^      eslint: */,"",r); print pkg" -> "r}' \
    pnpm-lock.yaml | sort -u
  ```

  It tracks entry into and exit from each `peerDependencies:` block on
  purpose. A shorter version that just greps every six-space-indented
  `eslint:` line also reads the `dependencies:` blocks, where `eslint:
  9.39.5(jiti@2.7.0)` is a *resolved version*, not a peer range — which
  reads as a package pinned to 9 and would manufacture a blocker that
  isn't there.

  So the thing to re-check before retrying is **`eslint-config-next`
  shipping a release whose whole plugin set accepts ESLint 10**, not
  `eslint-plugin-react` on its own — fixing only the crashing plugin still
  leaves two unsatisfied peers behind it.

  **Watch which peer you are reading, because this package has two and
  only one of them is satisfied.** `typescript-eslint`'s `eslint` peer
  covers `^10`; its `typescript` peer still caps at `<6.1.0`, which is the
  separate TS 7 blocker documented directly above. One package can block
  two different bumps and be clear for one of them, so verify each named
  blocker on its own rather than treating a `[blocked]` note as a single
  atom that expires all at once.

  **The automated `ai-failure-analysis` comment on the original PR is
  wrong** — it suggested bumping to
  `eslint-plugin-react@^7.38.0`/`^7.39.0`; neither version exists on npm
  (verified directly, `npm view eslint-plugin-react@7.38.0` 404s). Treat
  that job's suggestions as unverified, same as always — this is a
  concrete instance of it fabricating a plausible-sounding but nonexistent
  fix.

  **`@eslint/js` is the same family, not a separate issue** — its own PR
  (#25) is closed with no replacement open, but the package stays in
  `known-outdated-packages.txt` per the rule above. `@eslint/js` tracks
  ESLint's own major version, and `10.0.1` declares a peer of `eslint:
  ^10.0.0` — optional, which is why `lint` doesn't actually crash on this
  one, since apps/api's `eslint` stays pinned at `^9.18.0`. A real,
  verified, unsupported major-version pairing: check it with `npm view
  @eslint/js@10.0.1 peerDependencies`, which is reproducible now that the
  closed PR's lockfile entry is gone. Before attempting either bump again:
  re-run the peer-range check above and confirm all three capped plugins
  now cover `eslint@^10` (whether by their own releases, or by
  `eslint-config-next` dropping or replacing them) — once so, both become
  normal bumps like any other Dependabot PR, ideally merged together since
  they're the same major.
- **`gh api -f key=@path` does NOT read the file — only `-F` does.** The
  `@<path>` (or `@-` for stdin) file-reading syntax is documented under
  `-F/--field` (typed parameters) only; `-f/--raw-field` treats an `@...`
  value as a literal string. `gh api -X PATCH .../comments/$id -f
  body=@/tmp/file.md` silently posts the seven-character string
  `@/tmp/file.md` as the comment body, not the file's content. Caught by
  hand while editing an override-decision-log comment, then found the
  exact same bug already live in the `changes` job's "Comment skip logic
  on PR" step — and it's self-hiding: corrupting the body also destroys
  the `<!-- ci-skip-logic-comment -->` marker that step's own
  find-existing-comment lookup depends on, so the *next* push can't find
  the (now-corrupted) comment, falls through to creating a fresh one, and
  the cycle repeats — one broken, orphaned comment left behind every
  other push, forever, on any PR that gets more than one push. Fix is
  just the one-character flag swap (`-f` → `-F`); grep for `-f [a-z_]*=@`
  across `.github/workflows/` if this pattern ever gets copied elsewhere.
- **`gh api --paginate --jq` runs the jq filter once PER PAGE, not once
  over the combined result.** A multi-page response piped through
  `--jq '[...]'` produces several complete JSON arrays emitted
  back-to-back — not one valid JSON value — so anything downstream doing
  a single `JSON.parse` on the output breaks silently once there's enough
  data to paginate (a live review caught this on the override-decision
  log's `Fetch prior override decisions` step, which only fetches PR
  comments — fine on any PR tested so far, broken on a long thread).
  `--slurp` wraps all pages into one outer array, but the gh CLI flatly
  rejects combining `--slurp` with `--jq` — you can't just add it. The
  actual fix: fetch raw with `--paginate --slurp` (no `--jq`) and do the
  flattening/shaping downstream, in a language where it's unit-testable
  against a real multi-page shape (see `flattenPaginatedComments` in
  `scripts/lib/override-decisions.mjs`) — not in another bash/jq
  one-liner that would have the exact same blind spot.
- **A failed step skips every later step in the same job by default, not
  just the failing one.** GitHub Actions' implicit `if:` on a step with no
  explicit condition is `success()` — so a step that fails without
  `continue-on-error: true` silently cancels everything after it too,
  unless a later step opts back in with its own `if: always()` (as
  `Post review verdict` does). Hit `ai-code-review`'s `Fetch prior
  override decisions` step exactly this way: it fetches PR comments as
  optional context and was never meant to be able to block anything, but
  because it had no failure handling of its own, a transient `gh api`
  error would fail the step outright and skip `Review with ChatGPT`
  entirely on the same run — turning an optional context source into a
  hard dependency for the whole review. Fix (and the general pattern for
  any future "nice to have, must not become load-bearing" step): make the
  step itself unable to fail, e.g. `set +e` plus an explicit fallback
  value on empty/failed output, rather than reaching for
  `continue-on-error` — that marks the step as failed-but-ignored in the
  UI for something that isn't actually a failure once it's handled.
- **`node:26-alpine` dropped bundling Corepack.** `RUN corepack enable` alone
  now fails with `corepack: not found`. Fix: `RUN npm install -g corepack &&
  corepack enable`. Hit this on both `apps/api/Dockerfile` and
  `apps/web/Dockerfile` (Dependabot's node-22→26 bump PRs).
- **The two Lighthouse-adjacent budget numbers must move together.**
  `apps/web/test/bundle-budget.spec.ts`'s `JS_BUDGET_BYTES` (curl-measured,
  real wire bytes — the canonical number, with a documented raise history in
  that file's comment) and `apps/web/scripts/perf-budget.mjs`'s
  `jsBudgetBytes` (deliberately mirrors the spec file) must match. Lighthouse's
  own `resource-summary` transferSize reads ~3KB higher than curl's
  `size_download` for the identical build — that's HTTP response header bytes
  Chrome's DevTools Protocol counts and curl's body-only measurement doesn't,
  not a real size difference. Verified directly: same 8 chunks, same code,
  185.5KB via curl vs. 188.7KB via Lighthouse.
- **`perf-budget.mjs` audits two pages, not one — the default page alone
  provably couldn't have caught a real regression.** A manual Lighthouse
  audit against the deployed site (2026-08-17) found LCP at 3.1s (over the
  2.5s budget) on `/hi?page=2` specifically, while the script's own
  default-page check was passing cleanly the whole time. Root cause,
  confirmed via the audit's own `lcp-discovery-insight` (score 0):
  `product-card.tsx`'s `<Image fill>` never passed `priority`, so Next
  defaulted every card — including the first, above-the-fold one that's
  the actual LCP element on a direct-navigation page load — to
  `loading="lazy"`. Fixed two ways, not one: `ProductCard` now takes a
  `priority` prop and `product-listing.tsx` passes `priority={index === 0}`
  (deliberately keyed on array index, not `page === 1` — whichever page a
  direct navigation actually lands on, e.g. a shared `?page=2` link, its
  first-rendered item is *that* load's LCP candidate, not necessarily page
  1's); and `perf-budget.mjs` now audits `/hi?page=2` as a second page
  alongside the default, both gated on the identical budgets (same JS
  bundle either way; LCP budget is a property of the experience, not the
  locale). The badge/history dashboard publish step still reads only the
  default page's result, deliberately — that's an existing single time
  series, and the second page is a budget gate (still fails the whole job
  on regression) rather than a second tracked metric. Doubles this job's
  Lighthouse run count (10 audits instead of 5) — an accepted, bounded
  cost for closing a real blind spot, not added speculatively.
- **Lighthouse's performance *score* is genuinely noisy on GitHub's shared
  runners** — the same commit scored 70, then 85, then passed cleanly (98-99)
  across consecutive runs, while 5 back-to-back local runs on unshared
  hardware were rock-solid at 96-97 every time. `total-blocking-time` reacting
  to runner CPU contention is the mechanism. `perf-budget.mjs` now runs
  Lighthouse 5x and judges the budget against the **median** score/LCP/JS
  bytes (fresh headless Chrome per run) instead of trusting a single sample —
  this is what Lighthouse CI itself does by default. If this check flakes
  again, that's a real anomaly worth a closer look, not just "run it again."

  **Median-of-5 turned out not to be enough, and as of 2026-08-19 the CI
  job only *enforces* the JS budget.** The advice directly above — treat a
  flake as a real anomaly — was measured and found wrong: across the last
  40 CI runs, `perf-budget` executed 10 times and **failed 7**. Six of
  those seven were LCP-only; exactly one involved a genuine JS regression
  (PR #94's real +2.3KB). A 70% failure rate on a *required* check inverts
  its meaning — every red becomes noise to dismiss rather than a signal to
  act on, which is precisely the state that gets a check bypassed by
  habit. The decisive evidence: a `workflow_dispatch` run of
  `perf-budget` against **unmodified `main`** failed at 2.8s median, and
  within that same batch of five LCP measured 1.4s, 2.4s, 2.8s, 2.8s and
  3.3s. `main` could not reliably pass its own required check.

  The split follows what each metric actually is. JS transfer is
  **deterministic** — PR #94 reported an identical 192.3KB across a
  failing run and a passing run of the same commit, so a change in it is
  always real. LCP and the overall score are **timing-sensitive** and
  reflect runner contention more than code. So `PERF_BUDGET_ENFORCE`
  (default `score,lcp,js`, so a local `pnpm test:perf` is unchanged) is
  set to `js` in `ci.yml`: everything is still measured, printed, and
  published to the dashboard history, but only the deterministic budget
  blocks a merge. LCP moved from "blocks the merge" to "tracked as a
  trend". Revisit enforcing it if runs ever move to dedicated hardware, or
  if the budget gains enough margin to survive the observed spread — not
  by reflexively re-enabling it.
- **Turbopack's source maps DO resolve now — this entry used to say they
  don't.** It recorded that `<hash>.js` chunks referenced a `.js.map` under an
  unrelated hash, so `source-map-explorer` could not be pointed at the obvious
  path. Re-measured 2026-08-30 against production: every one of the 11
  referenced maps returns `200`, and per-module attribution works. Lighthouse's
  "mapping for last column out of bounds" warning is still harmless.

  Worth keeping because the capability is genuinely useful and the old note
  said it was unavailable: parsing `sources` and `sourcesContent` out of
  `apps/web/.next/static/chunks/*.js.map` gives a per-package byte breakdown in
  one pass, no tooling. That is how the "our own code is 8% of the bundle, 188
  KB against 2,119 KB of dependencies" figure was produced, and how three
  suspected-unused dependencies were cleared. Grepping the raw chunk for
  library signature strings still doesn't work (fully stripped, no license
  banners, no module-path comments in production output) — read the maps
  instead.
- **`radix-ui`'s barrel import is not a real bundle-size cost.** Its
  `package.json` declares `sideEffects: false`, so already-scoped named
  imports (`import { Dialog } from "radix-ui"`) tree-shake correctly without
  needing `experimental.optimizePackageImports` — verified empirically
  (byte-identical build output with vs. without the config flag). Next.js's
  own default `optimizePackageImports` list includes `lucide-react` but not
  `radix-ui`; that's fine, don't add it back without new evidence it helps.
- **`ai-code-review`'s `OPENAI_API_KEY` was observed empty on a
  `dependabot/github_actions/*` PR (#44, `dorny/paths-filter` v3→v4),
  reproduced identically on a full `gh run rerun`** — the job crashed
  with `OpenAIError: Missing credentials`, not the usual fail-closed
  REQUEST_CHANGES-with-a-real-verdict path. `secrets.OPENAI_API_KEY`
  exists at the repo level (confirmed via `gh secret list`) and other
  Dependabot PRs the same day, on the `npm_and_yarn` ecosystem, got real
  reviews with the secret present — so this isn't a blanket "Dependabot
  never gets secrets" rule, and it wasn't transient (same result twice).
  Not fully root-caused — the leading hypothesis is that it's specific to
  `github_actions`-ecosystem Dependabot PRs and/or PRs that modify a
  workflow file themselves (unverified; the historical PRs checked to
  test this theory, #20-23, predate `ai-code-review`'s current form or
  lack matching log data to confirm either way). If this recurs, that's
  the first thing to check systematically — e.g., deliberately trigger
  it on both a workflow-file-touching and a non-touching
  `github_actions`-ecosystem PR side by side. In the meantime: this is
  the same "review didn't complete" case the job already fails closed
  for by design (see the AI code review gate section above) — verify the
  change by hand (for an action-version bump, read its release notes via
  `gh api repos/<owner>/<repo>/releases` for breaking changes) and
  admin-bypass with the reasoning posted as a PR comment, same as any
  other override. Observed on `ai-code-review` specifically (this
  predates the two-pass split), but the same `secrets.OPENAI_API_KEY` /
  `pull_request` combination now also applies to `ai-ci-results-review`
  — if this recurs, check both jobs, not just one.

## Edge-caching GraphQL GETs — and why errors must be excluded

`apps/api` marks read-only GraphQL GETs cacheable (`graphql-cache.ts`:
`public, max-age=0, s-maxage=60, stale-while-revalidate=300,
must-revalidate`) so a CDN serves a product listing without a trans-Pacific
hop to Render.

**The trap: GraphQL reports resolver failures as HTTP 200 with an `errors`
array.** Whether a response succeeded is a property of the BODY, not the
status line. The original middleware replaced `Cache-Control`
unconditionally, so errors went out fully cacheable — verified live before
fixing:

```
{product(id:"does-not-exist-abc"){id}}
→ HTTP/2 200 + public, max-age=0, s-maxage=60, stale-while-revalidate=300
```

Harmless while nothing cached them; behind a CDN it is an outage amplifier.
A one-second database blip is stored at that edge for `s-maxage`, then
served stale for the whole `stale-while-revalidate` window on top, to
everyone routed through that location — and there is no purge hook to cut
it short.

**Why `res.send`, not `res.setHeader` and not `res.end`.** Apollo's express
integration does this, in this order:

```js
res.setHeader(key, value);          // headers FIRST
res.statusCode = response.status;   // status AFTER them
res.send(response.body.string);
```

At `setHeader` time the status is still the default 200 and no body exists,
so the old wrapper decided blind — and decided "cacheable" every time.
`res.send` is the first point where status and complete body are both final,
and it runs **before Express's conditional-GET transform**. That matters:
Express builds a 304 by blanking the body and stripping `Content-*` while
leaving `Cache-Control` alone, so deciding at `end` would see an empty body,
refuse it, and let Apollo's `no-store` ride out on the 304 — telling a shared
cache to drop an entry it had just confirmed fresh, turning cheap
revalidation into a permanent miss. Deciding at `send` also keeps the outcome
independent of Apollo's plugin ordering.

`isCacheableGraphqlResponse` **fails closed in every branch**: unparseable
body, non-object JSON, missing `data`, any `errors` key at all (including an
empty array), absent chunk, any status but 200. Not caching something
cacheable costs a round trip; caching an error costs an outage.

`Timing-Allow-Origin` is deliberately **not** tied to cacheability — it is
set on every GET. Browsers zero cross-origin timing data without it, and a
failing request is exactly the one worth measuring from RUM.

Verified in both directions: the regression tests in `products.e2e-spec.ts`
fail against the old middleware and pass against the new, over real HTTP
through the real stack. The 304 assertion guards the `send`-vs-`end`
placement — it passes under both, so it protects the fix rather than proving
the bug.

**Pairs with a Cloudflare Cache Rule** ([docs/cloudflare.md](./docs/cloudflare.md)).
Two non-default settings are load-bearing: match on `http.request.uri.path`,
**not** `http.request.uri` (which includes the query string, so it never
equals `/graphql` and the rule silently matches nothing); and Edge TTL must
be *"use cache-control header if present, bypass cache if not"*. The
neighbouring option caches responses arriving *without* a cache-control
header using Cloudflare's defaults — exactly the path an unexpected error
takes. With bypass, errors carrying Apollo's `no-store` are skipped
automatically, so no error-specific edge rule is needed.

**Revisit before login ships.** These queries are anonymous and sent with
`credentials: "omit"`, which is the only reason a shared cache is safe. An
authenticated response must never be edge-cached — that needs `private,
no-store` keyed off the request carrying credentials, and it must land
before the first authenticated query, not after.

## Three measured performance trade-offs, priced

Audited against live production at `e076f51` (2026-08-30). Each of these is a
**deliberate choice that is now costed** rather than a defect — recorded so the
next person weighs the same trade rather than rediscovering the number, or
"fixes" something that was chosen on purpose. The genuine gaps found in the
same pass are in [#173](https://github.com/nixsin/marketplace/issues/173).

Measure with a realistic browser `Accept-Language` and `Sec-Fetch-Dest`. A bare
curl lands on the one next-intl path that always writes a cookie and reports
`BYPASS` for everything, which is a failure real traffic never sees.

### `deploymentId` re-downloads the whole bundle on every deploy

`next.config.ts` sets `deploymentId` from `RENDER_GIT_COMMIT`, which appends
`?dpl=<commit>` to every asset URL. Those filenames are **already**
content-hashed and served `immutable`, so a chunk whose bytes did not change
ought to survive a deploy in the browser cache. The query string means none of
them do.

**Measured cost: 239 KB compressed, per returning visitor, per deploy** — 13
chunks, most of them byte-identical across a deploy that touched one file.

It buys real version-skew protection (#78 §3.3): a stale tab detects a new
deploy instead of calling an API route its own bundle no longer matches. That
is not theoretical here — a four-PR merge burst on 2026-08-19 put the web app
live calling a `product(id)` query the API had not deployed yet.

| Option | Gains | Costs |
|---|---|---|
| **Keep as-is** | Skew protection on every asset | 239 KB per visitor per deploy |
| **Scope `?dpl=` to HTML and RSC payloads only** | Static chunks keep `immutable`; skew still detected on navigation | A tab that never navigates keeps stale chunks — but it already does, since `deploymentId` does not reach a tab that never navigates either |
| **Drop it entirely** | Full `immutable` benefit | Loses the one control that caught a real outage |

The middle option is the one worth investigating: skew is detected on
*navigation*, and navigation is exactly when the HTML is re-fetched. Not done
here because it needs verifying against a real two-deployment test — the
interaction with the service worker's own stale-while-revalidate on navigations
is explicitly unverified, per `next.config.ts`'s own comment.

### Source maps are gated, not public and not deleted

`productionBrowserSourceMaps: true` stays on — a production stack trace that
resolves to a real file and line beats a minified offset, and browsers fetch
maps only with devtools open. The problem was never that they exist. It is
that `next start` serves everything under `.next/static`, so **anyone could
`curl` a map and read the complete original text of 34 of our files** — 2.38
MB of it, `packages/config` included, publishing every rate limit and ceiling
the app has. Verified against live production before the fix: the exact
`INQUIRY_RATE_LIMIT_PER_SELLER = 60` and `PER_PHONE = 5` behind
[#152](https://github.com/nixsin/marketplace/issues/152)'s accepted DoS
surface were readable with no authentication.

`scripts/privatize-sourcemaps.mjs` moves every map to `.next/sourcemaps/` and
repoints each chunk's `sourceMappingURL` at `/sourcemaps/<file>`, a route that
returns the map only to a request carrying a valid signed token in `mi_srcmap`.

**Maps are kept WHOLE rather than stripped.** Stripping `sourcesContent` was
the first attempt and it works, but it throws away the useful half for
everyone including us. Gating keeps the full map for a session that holds the
token and gives the public nothing — no exposure, no loss.

**`.next/sourcemaps/` is safe because `next start` publicly serves only
`.next/static/**`.** Verified directly rather than assumed: a canary file
placed elsewhere under `.next/` returns 404 at every path shape tried
(`/probe`, `/_next/probe`, `/.next/probe`). The prod image copies the whole
`.next` directory, so the maps travel with it and stay reachable to the route.

**Tokens are signed and self-describing, not one shared secret.** A shared
static secret would say nothing about who is using it, could not expire, and
revoking one person's access would mean rotating it for everybody. Each token
carries who minted it (`iss`), a distinct id per grant (`sid`), and an expiry
the server enforces — signed with `SOURCEMAP_SIGNING_KEY` so the identity
cannot be edited. Mint one with `pnpm --filter web sourcemap:token`; it
defaults to the git identity and a 2-hour life, with a 24-hour ceiling.

Verification is **stateless** — it needs only the key, so nothing is stored,
replicated or cleaned up. That matters because the thing being protected is a
debugging aid, and a debugging aid that needs its own datastore does not get
used. **Time-bounding is therefore the revocation mechanism:** there is
nothing to revoke, which is why the ceiling exists.

The signing/verifying code is a **subpath export**
(`@medinstru/config/sourcemap-token`), and that is load-bearing: the package's
main entry is imported by client components, so pulling `node:crypto` into it
would break the browser build. The client never imports this path.

**The signature is checked before any claim is read.** A payload nothing has
vouched for is attacker-controlled — an implementation that read `exp` first
would be acting on a value the caller chose. A forged token fails on the
signature, never on its own claims, and a test asserts exactly that by
checking the *reason*.

**Every access is logged with the issuer**, which is the whole point of the
identity: `{"msg":"sourcemap served","file":…,"iss":…,"sid":…}`. Refusals are
logged too, but only when a token was actually presented — otherwise every
crawler hitting the path buries the entries that mean something. The reason is
never returned to the caller: telling them whether the signature was wrong or
merely expired hands them a probing oracle.

**A cookie, not a header or query parameter.** Devtools fetches maps itself
and cannot be made to send a custom header; a token in a URL ends up in access
logs, referrers and shell history. The generator prints the exact
`document.cookie` line to paste.

**The route fails closed and 404s rather than 403s.** An unset
`SOURCEMAP_SIGNING_KEY` makes maps unavailable rather than public — a
misconfigured deploy must not fall back to the state this exists to end. A 403
would confirm something is behind the path; there is nothing to gain from
telling an unauthorised caller that.

**Nothing automated consumed these maps, and that is worth knowing before
weighing the trade.** There is no error-tracking service in the workspace —
no Sentry, Bugsnag, Rollbar, Datadog — and `reportApiFailure` logs
`error.message` to the visitor's own console, never a stack, never to us. The
sole beneficiary is a developer opening devtools by hand, which is exactly the
case the token now serves.

The `content-type` is JSON and `cache-control` is `private, no-store`: the
response varies by cookie, and an edge that cached one would hand it to
everyone.

### `product.count()` is the one catalogue query the index cannot help

`products.service.ts` runs an unfiltered `COUNT(*)` on every paged request, to
compute `totalPages`. No index serves that; Postgres walks the table. The
`Product(createdAt, id)` index added in #162 makes the *rows* free and leaves
the count untouched.

Irrelevant at today's few dozen products, and it does real work — the pager
renders `totalPages` directly. Recorded because it is the part of the catalogue
path whose cost grows with the catalogue while everything around it does not,
which makes it easy to misattribute later.

| Option | Gains | Costs |
|---|---|---|
| **Leave it** | Exact page count, always | One full scan per uncached paged request |
| **Cache the count separately, longer TTL than the page** | Nearly free; the count changes far less often than the rows | A newly added product can be missing from `totalPages` for the TTL |
| **Approximate from `pg_class.reltuples`** | O(1) | Only approximate, and stale between `ANALYZE` runs — wrong for a pager |
| **Drop `totalPages`, use has-more** | No count at all | Changes the pager UI from numbered pages to next/previous |

The second is the natural first move, and it composes with #173: once product
and catalogue pages are edge-cached, the count runs far less often anyway.

## The shared cache, and why invalidation is version-keyed

`apps/api` caches through Redis. **The service holds no cache state** — several
stateless instances behind a load balancer share one Redis, so they cannot
disagree about a cached value and an invalidation cannot reach only some of
them. An in-memory memo does both, which is why one was rejected here.

**Delete-on-write cannot be made reliable, and that decided the design.** The
obvious scheme is: write, then `DEL` the key. It has a window that does not
close — if the process dies, the pod is evicted, or the Redis call fails
between COMMIT and DEL, the stale entry survives its full TTL and *nothing
knows the invalidation was lost*. With several instances it is worse than
small, it is invisible.

Instead a single Postgres row holds a catalogue **version**, bumped **inside
the transaction that writes**, and the cache key embeds it:

```
v1:products:count:gen:41     ← before the write
v1:products:count:gen:42     ← after it
```

Invalidation stops being an action that can fail and becomes a *consequence of
the write committing*. A reader on version 42 cannot address the entry written
under 41. A rolled-back transaction leaves the version untouched, which is also
correct — nothing changed. Orphaned keys are never deleted; they expire.

**`bump()` takes the caller's transaction client, and that is the whole
guarantee.** Called on the service's own Prisma instance it would commit
separately from the write and reintroduce the gap. A test asserts the bump
lands on the passed client and not on `this.prisma`.

**Verified end to end, not reasoned about:** inserting a product and bumping
the version in one `psql` transaction moved the API's reported count from 16
to 17 on the very next request, with no flush and no `DEL` — and both
`gen:0` and `gen:1` were visible in Redis afterwards.

**The cost is one extra query per uncached read** — a primary-key lookup on a
one-row table, against the `COUNT(*)` full scan it protects. That cost is flat
as the catalogue grows, which is the entire point, since counting is not.

**Fails open, and `disableOfflineQueue: true` is what makes that TRUE rather
than aspirational.** node-redis QUEUES commands issued while disconnected and
replays them on connect — so against an unreachable Redis a `get()` never
settles, the error handling never runs, and the request hangs until something
upstream times out. The catch blocks look like they cover it and do not: a
hang is not an error. CI caught this, not local testing, because locally there
is always a Redis. Every e2e test failed with a 5s timeout rather than passing
on the null path.

**Shutdown is bounded for the same class of reason.** `quit()` on a client
that never connected waits for a connection that is not coming — unbounded,
that hangs a rolling deploy until the orchestrator SIGKILLs the pod. It races
a 1s timeout, then `destroy()`, and that `destroy()` is itself wrapped because
it throws "The client is closed" when it already is, which would fail the
caller's teardown for a state that is already what we wanted.

**`REDIS_URL` is deliberately EMPTY in `apps/api/.env.example`.** CI copies
that file verbatim (`cp .env.example .env`), so a URL pointing at a Redis no
job runs makes every one construct a client and log cache-unavailable for the
whole run. The API treats the cache as optional, so blank is both honest and
correct.

No `REDIS_URL` yields a null cache and every read falls through to Postgres,
so a bare local run and the e2e suite work unchanged. An unreachable Redis
behaves the same way — verified by running the e2e suite against a closed
port, which is the only way to see this failure at all. Health is tracked as a
*state* and logged only on transition, because a cache that has been down for
three weeks looks exactly like one that is merely cold — one loud line beats
ten thousand identical warnings nobody reads.

**The e2e suite needs the migration.** `CacheVersion` missing from
`medinstru_test` makes the resolver throw, which surfaces as
`Cache-Control: no-store` rather than as an obvious database error — because
`isCacheableGraphqlResponse` correctly fails closed on any `errors` key. Run
`pnpm --filter api test:e2e:migrate` when a cache-related e2e test fails for a
reason that looks like caching.

### Durability declared as code, for both stores

**Redis:** `--appendonly yes --appendfsync everysec --save ""` in
`docker-compose.yml`, and `persistence_mode = "journal_snapshot"` on the
Render Key Value instance. Note the vocabulary gap: Render does **not** accept
`"aof"`, and `terraform validate` is what surfaced that — the accepted set is
`["journal_snapshot" "snapshot" "off"]`. Do not assume a provider mirrors the
underlying engine's names.

Worth being honest about what this buys: everything cached is derivable from
Postgres, so losing it costs latency, not data. It is set because a cold cache
after every restart makes an outage worse at exactly the wrong moment.

**Postgres:** `parameter_overrides` on `render_postgres` is where WAL settings
belong, and it is **empty by default on purpose** — the free tier does not
accept overrides, and sending any would fail the apply. The values worth
setting on a paid plan (`wal_level`, `max_wal_size`, `checkpoint_timeout`,
`wal_compression`) are documented next to the resource so moving plans is a
variable change rather than an archaeology exercise.

**The whole path is code — creation AND wiring.** `enable_key_value = true`
then `terraform apply` creates the instance, an env group carrying `REDIS_URL`,
and the link attaching that group to the API service. Nothing is done in the
dashboard.

The credential is never handled by a person: Terraform reads
`connection_info.internal_connection_string` straight off the Key Value
resource and writes it into the env group. Render generates it, Terraform
moves it, the API receives it — it is never typed, pasted, or in a shell
history. The **internal** string, not the external one: both services sit in
the same Render environment, so this keeps the traffic off the public network.

**An env group rather than `env_vars` on the service**, because
`render_web_service.api` carries `ignore_changes = all` — provider v1.9.1
sends `maintenance_mode` fields Render rejects for free services, which
produced a partial apply. Linking a group sidesteps it: the service resource
is untouched and the link is its own resource.

**`plan` defaults to `free`**, matching every other service here — the
provider accepts `free`, `starter`, `standard`, `pro`, `pro_plus`. One caveat
the schema cannot express: whether a plan accepts `persistence_mode`. Free
tiers on Render have rejected settings the schema validates happily before
(`parameter_overrides` on free Postgres is the same shape), so a refused apply
there is the plan talking, not the configuration — drop
`key_value_persistence_mode` to `"off"` or move to `starter`.

`enable_key_value` still defaults to **false**, so a plan creates nothing
until someone decides to. The API runs without a cache by design.

## Deployment

**Terraform for Render and Cloudflare lives under `infra/terraform/`**
(added 2026-08-20). The stacks intentionally keep separate state so the
Cloudflare adoption does not require immediately adopting the already-live
Render resources. The Render resources must be imported before apply; an
unimported apply would create duplicates. The official Render provider does
not accept the legacy free web-service plan, so the configuration uses a
schema-valid `starter` placeholder while lifecycle ignores the imported
services' `plan`; plan changes remain manual and cannot accidentally become a
paid upgrade through Terraform. Existing Cloudflare DNS, R2, and cache-rule
resources must likewise be imported before their first plan. The existing R2
custom domain stays dashboard-managed because Cloudflare provider v5.23 does
not support importing that resource. See the stack README for the exact
adoption order and cache-safety decisions.

Cloudflare cache-ruleset adoption is off by default. A zone-level ruleset owns
its entire phase, so importing a live ruleset into a one-rule configuration
would delete every unrepresented dashboard rule on apply even with
`prevent_destroy`. Enable `adopt_cache_ruleset` only after inventorying the
complete phase, representing every additional rule, and setting the separate
`cache_ruleset_inventory_confirmed` acknowledgement.
The managed rules are appended after that inventory: two eligibility rules
(anonymous GraphQL GETs, anonymous page HTML) followed by three bypasses
(session-bearing web requests, every locale-negotiated path, every other API
request).

**The negotiated-path bypass covers far more than `/`.** The set is whatever
`apps/web/src/proxy.ts`'s matcher admits -- any dotless path outside
`api`/`_next`/`_vercel` -- because all of those pass through next-intl and are
answered with a redirect chosen from `NEXT_LOCALE` and `Accept-Language`,
neither of which is in the cache key. It began as a root-only rule and that was
too narrow: `/products`, `/foo` and `/about` negotiate exactly like `/` and were
uncached **only because next-intl happens to set a cookie on them**. That is an
accident, not a guarantee -- `localeCookie: false` would remove it and start
serving one visitor's language to everyone. `/sitemap.xml` and `/favicon.ico`
are unaffected: they contain a dot, so they never reach the middleware. The
locale list is a Terraform variable, with
`scripts/cloudflare-locale-drift.test.mjs` asserting it matches `LOCALES` in
`packages/config`, because drift is silent in both directions. The API bypass is what
neutralizes an earlier imported rule that was broader than intended -- it is
the exact complement of its eligibility condition across the whole API
hostname, so every other API path is bypassed too; only the canonical
`/graphql` path with an anonymous, cookieless GET is cache-eligible.

**Order is load-bearing and fails silently.** Cloudflare evaluates every
matching rule in sequence and the last match wins, so a bypass placed before
its own eligibility rule is overridden by it with no error anywhere. The
bypasses must stay last; a test asserts the relative order.

**The two cookie tests are deliberately different -- copying one onto the other
breaks it.** The API rules bypass on *any* cookie, correct there because every
GraphQL read is anonymous and sent with `credentials: "omit"`. HTML cannot use
that test: next-intl sets `NEXT_LOCALE` on every page response, so every
returning visitor carries a cookie and nothing would ever cache. HTML keys on
the `mi_sid` session cookie alone, read through `http.request.cookies` (the
parsed map) and never `http.request.headers["cookie"]` -- `[0]` sees only the
first Cookie line, and HTTP/2 permits splitting Cookie across several, so a
session in a later line reads as anonymous and lands in a shared cache. `NEXT_LOCALE` is safe because it is derived
purely from the URL, which is already in the cache key.

**The `Set-Cookie` risk was investigated live on 2026-08-21 and did not
materialise -- HTML caching works.** next-intl does not set `NEXT_LOCALE` on
every response: per `middleware/syncCookie.js`, it writes the cookie only when
an existing one is outdated, or when there is none *and* `Accept-Language`
disagrees with the page's locale. A browser viewing the locale its own
`Accept-Language` implies gets no `Set-Cookie`, so the response is cacheable,
and once one such request populates the edge everyone gets a `HIT`.
`localeCookie: false` is therefore **not** needed.

**There is a third condition the paragraph above omits, and it widens
cacheability further.** `syncCookie` returns early for any request whose
`Sec-Fetch-Dest` is present and not `document`, so prefetches and the router's
own cache revalidations never write `NEXT_LOCALE` -- only real navigations do.
next-intl's stated reason is correctness rather than caching (Next 16.3's
router revalidates routes of a locale the user just switched away from, and
updating the cookie from such a request would overwrite the locale they had
just chosen), but the caching consequence is real.

Recorded here after nearly being recorded wrongly: this guard was first read
in 4.14.0 while reviewing that bump and written up as something 4.14.0 added.
It is not -- `syncCookie.js` is **byte-identical between 4.13.6 and 4.14.0**.
Reading only the new version's source cannot tell you what changed; diffing
the two can, and it is one command. The general form is worth more than the
instance: *"I read the new code and it does X"* is not evidence that X is new.

`apps/web/test/locale-cookie-caching.spec.ts` now asserts all three conditions
over real HTTP against the production build, so this no longer depends on
anyone re-reading a dependency's source on upgrade day. It is deliberately
version-agnostic -- it pins the property the Cloudflare HTML rules need, not
one release's implementation of it -- and it sends a realistic
`Accept-Language` on every request, for the reason the paragraph above gives.

The trap worth remembering: `curl` sends no `Accept-Language`, which no browser
does, so it hits the one path that *does* write a cookie and reports `BYPASS`
every time. Diagnosing cache behaviour with a bare `curl` reproduces a failure
real traffic never sees -- always pass a realistic `Accept-Language`.

Both eligibility rules set edge **and** browser TTL to `respect_origin`.
Browser TTL is explicit rather than omitted because omitting it falls through
to the zone default of 4 hours -- which once overrode `max-age=0` and left
browsers holding stale API responses. Full table in
[infra/terraform/README.md](./infra/terraform/README.md).

The first version incorrectly added AWS CloudFront Terraform after reading
“Cloudfront” literally. Its claim that distributions already existed was also
erroneous, written without evidence; the repository owner explicitly confirmed
they have no AWS account. No AWS credentials, apply, import, or Terraform state
ever existed, so there is no CloudFront infrastructure or state to migrate.
The Cloudflare replacement is a fix-forward correction, not a provider
migration.

Production Terraform state is stored in the `nixsin-marketplace` HCP Terraform
organization, using separate `marketplace-render-production` and
`marketplace-cloudflare-production` workspaces in local-execution mode. The
imported Cloudflare zone cache-settings phase has the provider-assigned,
immutable name `default`; changing that name forces replacement and is blocked
by `prevent_destroy`.

The Render provider requires the non-secret owner ID
`tea-da02feht0dsc738nmfv0`. Production Postgres belongs to project environment
`evm-da02hptg1s2s73c6e7tg`; both IDs are declared in Terraform so a plan cannot
detach the imported database from that environment.

The two legacy-free Render web services are update-frozen in Terraform. Provider
v1.9.1 reads `maintenance_mode = { enabled = false, uri = "" }` from Render and
then sends it on every service update; Render rejects maintenance-mode fields
for free services, causing a partial apply. Their lifecycle therefore uses
`ignore_changes = all` plus `prevent_destroy`. Read-only service data lookups
are creation guards: if a service disappears outside Terraform, planning fails
instead of recreating it. Recover/recreate it manually, update the declared ID
if it changed, and let the permanent import block readopt the same state
address. The permanent import blocks also prevent an empty/recovered HCP state
from planning duplicate production resources. Keep service settings managed
via the Render dashboard/API until the services are upgraded or the provider
fixes this behavior. Render Postgres is still fully managed.

Render Postgres must explicitly keep `ip_allow_list = 0.0.0.0/0` while GitHub
Actions applies migrations through its external endpoint. Provider v1.9.1
cleared the imported allow-all entry when this optional-computed field was
omitted, producing Prisma `P1017` in the post-merge migration job even though
the API stayed healthy over the internal database connection. This is the
pre-existing password-authenticated, TLS-protected posture, not a new exposure,
but it remains broader than ideal. Narrow it only together with a stable-egress
self-hosted runner or private Render-side migration mechanism; GitHub-hosted
runners have no single stable IP to allow-list.

Render (`render.yaml` documents the live setup; not connected as an active
Blueprint sync — see that file's own comment for why). Migrations run in
CI's `migrate` job against the External DB URL (the prod Docker image has no
Prisma CLI — `pnpm deploy --prod` drops devDependencies, and Render's
free-tier Pre-Deploy Command is locked). `autoDeployTrigger: checksPass`
means Render itself waits for all required checks before deploying —
another reason a red required check must never be routed around.

**`medinstru-postgres` is on Render's Free tier, deliberately, and expires
2026-09-14.** Free Postgres on Render auto-deletes 30 days after creation
(created 2026-08-15). If this is being read on or near that date, check the
Render dashboard first — if it hasn't been upgraded to a paid tier or
recreated, flag it immediately before doing anything else; expiry means the
production database and everything in it gets deleted. Don't assume it's
still fine just because CI is green.
