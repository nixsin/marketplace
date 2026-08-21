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

1. Branch off `main` (`git checkout main && git pull --ff-only`, then a new
   branch — never commit directly to `main`).
2. Make the change, verify it locally (build/test/lint as relevant — see
   docs/development.md's Testing section), commit.
3. Push, open a PR (`gh pr create`).
4. Wait for CI. Fix forward on the same branch if something fails — don't
   force-push over history unless specifically asked.
5. Squash-merge (`gh pr merge --squash`).
6. **After merging, check CI on `main` itself — a PR's own green run does
   not guarantee the post-merge push-to-main run is green too.** Squash-
   merging creates a brand-new commit, and `push` triggers an entirely
   separate CI run for it — a genuinely different data point, not a re-
   display of the PR's result, and it's what actually gates Render's
   `autoDeployTrigger: checksPass`. Confirmed live (PR #54, 2026-08-17):
   the PR's own Lighthouse run passed clean (LCP 2.3s), but the very next
   push-to-main run on the identical squash-merged commit failed —
   `perf-budget` was missing an explicit `permissions: contents: write`
   block, which `test-api-unit`/`test-web` already had for the same
   badge-publish reason (see "Known gotchas" below). A required check
   failing post-merge is exactly the situation the hard rule above exists
   for — investigate and fix forward on a new branch, the same as any
   other failing required check; don't treat "but the PR was green" as a
   reason to leave it.

   **Now partially automated** — the `comment-ci-result-on-pr` job (added
   2026-08-17, see its own section below) posts the push-to-main result
   directly on the merged PR once that run finishes, with a per-job
   breakdown and a direct link, specifically so this doesn't require
   already knowing to check the Actions tab separately. Still worth
   confirming by hand the first several times this fires for real —
   like the force-run mechanism elsewhere in this file, a job that only
   triggers on `push` to `main` is structurally untestable before its
   own introducing PR actually merges, so treat its first few live
   firings as still-being-verified, not a settled fact. Manual fallback
   unchanged: `gh run list --branch main --workflow ci.yml --limit 1` —
   never the (now-closed) PR's own Checks tab, which only ever shows the
   `pull_request`-triggered runs from while it was open.

Branch protection on `main` currently requires **11 checks** plus 1 approving
review: Lint, Dependency audit, API unit tests, API e2e tests, Web build +
tests, Web e2e (Playwright), Web performance budget (Lighthouse), Docker
image vulnerability scan, Docker dev stack smoke test, Docker web prod image
boot test, and CodeQL (Analyze). Treat that list as a snapshot and query the
API below rather than trusting it — protection changes without touching the
repo, and this line has been stale before.
`enforce_admins` is `false`, so `gh pr merge --admin` bypasses the **review**
requirement. This repo has one active contributor, so admin-bypassing the
review gate on an otherwise-green PR is the established, expected pattern —
not a red flag. Check current protection with:

```bash
gh api repos/nixsin/marketplace/branches/main/protection --jq '{required_checks: .required_status_checks.contexts, required_reviews: .required_pull_request_reviews.required_approving_review_count}'
```

### The one hard rule: never merge past a failing required check

Admin-bypass gets you past the *review* requirement only. **Never use it to
merge past a check that's actually failing** — most importantly Lighthouse
(`perf-budget`), which became a required check on 2026-08-16 specifically
because it had been getting bypassed. If a required check is red:
investigate and fix it, or get explicit sign-off before doing anything else
(e.g., temporarily pulling it out of required checks). Don't route around it
silently. A check that's *skipped* (via the path filter, see below) is fine
to merge past — only an actual failure blocks.

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

Keeps every open PR targeting `main` in sync on three axes, event-driven
(`pull_request: types: [closed]`, merged-into-main guard) **and**
scheduled (daily `cron`, since PR drift accumulates faster than the
event-driven trigger alone catches — a failed update call, a PR opened in
the gap between runs, drift from something other than a merge). Also
triggerable by hand (`workflow_dispatch`). Started as just "auto-update
open PRs after a merge" (the file's original name) and was broadened —
renamed accordingly.

For every open PR targeting `main`:
1. **Freshness** — attempts `update-branch` (same operation as `gh pr
   update-branch` / GitHub's "Update branch" button). A non-zero result is
   expected/harmless when already current; not worth guessing at GitHub's
   exact error wording to classify it.
2. **Real conflicts** — `mergeStateStatus: DIRTY` means an actual merge
   conflict step 1 can't fix on its own. Flagged with an edit-in-place PR
   comment (`<!-- pr-reconciliation-conflict -->` marker) so it doesn't
   sit invisible in an Actions log; updated to say "resolved" once it no
   longer applies, rather than left as a stale warning.
3. **Stuck workflow approval** — flags (`<!-- pr-reconciliation-stuck-approval -->`
   marker) a PR whose latest run has sat at `action_required` (see the
   Dependabot section below) for over 24 hours.

All three only **surface or retry** — nothing here auto-resolves a real
conflict or auto-approves a stuck workflow run; those stay human
decisions. `set +e` (plus `pipefail`) throughout, same reasoning as the
`ai-code-review` fix: one PR's failure must not stop the rest from being
reconciled.

**The actual flag/resolve/skip decisions live in a tested module, not
inline bash.** `scripts/lib/pr-reconciliation.mjs`
(`pr-reconciliation.test.mjs`) — this job's bash only gathers each
decision function's inputs and acts on its output. That split exists
because this job's introducing PR went through **four live review
rounds and found six real bugs**, every one in the identical shape: a
failed or non-conclusive lookup silently treated as a conclusive one.

These tests also run in `ci.yml`'s own `test-ci-scripts` job — a plain,
unconditional job (no path filter) on every regular PR, separate from
`pr-reconciliation.yml`'s own steps. Needed because
`pr-reconciliation.yml` never triggers on `pull_request` — without this,
a regression to this file would ship straight to `main` unnoticed by the
introducing PR's own CI, only surfacing later when
`pr-reconciliation.yml` next actually ran (close, schedule, or manual
dispatch). A live review caught this gap directly; `test-ci-scripts`
closes it and is wired into `ai-code-review`,
`ai-failure-analysis`, and `migrate`'s `needs:` lists the same way `lint`
is.
1. Every `gh pr view`/`gh pr comment` call needs `--repo` explicitly —
   this job never runs `actions/checkout` for its main step, so without a
   local git repo `gh` has no way to resolve a bare PR number.
2. The marker-lookup pipelines must pipe `gh api --paginate` (no `--jq`)
   into a separate `jq --arg m ...` — `gh api --jq` takes exactly one
   string argument; passing jq's own `--arg` after it is a hard parse
   error.
3. A failed status lookup (`gh pr view`/`gh run list`) must not be read
   as "confirmed clean/not stuck" — under `set +e` a failure and a
   genuine clean result look identical unless the lookup's own exit
   status is captured explicitly (`if var=$(cmd); then`, never a bare
   assignment followed by a value check).
4. `mergeStateStatus: UNKNOWN` is a real, documented value of the
   `MergeStateStatus` GraphQL enum (GitHub still computing mergeability),
   not an error — it needs its own branch, or it falls through to
   "resolved" exactly like bug 3.
5. The marker-lookup pipelines (`gh api | jq | head -1`) need `pipefail`
   — without it, `head -1` exits 0 on empty input regardless of whether
   that's a genuine zero-match result or an upstream `gh api`/`jq`
   failure, so a real failure could produce a *duplicate* comment instead
   of editing the existing one.
6. `pr_numbers=$(gh pr list ...)` failing is indistinguishable from a
   genuinely empty PR list unless its own exit status is captured too —
   otherwise a real API/auth failure silently reports "no open PRs" and
   exits 0, making the scheduled safety net look successful while doing
   nothing.

Every one of these was independently reproduced (a real bash repro, or a
direct GraphQL schema/`gh` CLI check) before being fixed — see this
workflow's own git history for each round. The lesson that stuck: after
finding the same bug shape five times in untested inline bash, the sixth
review round asked for actual test coverage directly, which is what
produced the extraction — the same "pull the pure logic into a tested
module" move already proven on `review-verdict.mjs` and
`override-decisions.mjs` above.

Comment bodies are built with `printf '%s\n%s'` (marker, message), not
raw multi-line bash string literals inside the `run: |` block — a literal
newline mid-string puts the continuation line at column 1, which breaks
YAML's block-scalar indentation rule and is a real parse error. Caught by
validating this file's YAML locally before it was ever pushed.

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

`scripts/ai-code-review-precheck.mjs` runs a reviewer locally, on every
`git push` — a fast preview before spending a full CI round-trip on a
finding you could've caught yourself. Two goals: catch real issues
before they cost a CI cycle, and converge the eventual CI review faster
(see the "How to avoid a perpetual review/fix cycle" section above) by
feeding the same PR's existing override-decision log back in, so
something already disputed with a real reviewer doesn't get re-raised
here too.

**Its closest CI counterpart is now pass 1 (`ai-code-review`), not "the
CI job" generically** — since the two-pass split, pass 1 is *also*
diff-only with no CI grounding, the same design this precheck already
had. As of 2026-08-19 it also runs at the *same* reasoning effort as pass
1, so exactly one real difference remains (the precheck predates the
split, back when there was only one CI job to compare against and "no CI
grounding" was a real gap between them — it no longer is, for pass 1
specifically):
- **Fails OPEN, not closed.** A missing local `OPENAI_API_KEY`, a network
  error, or any other failure to get a usable review prints a warning and
  lets the push through, unlike `ai-code-review.mjs`'s fail-closed design.
  The real CI gate still runs on the PR regardless and still fails closed
  exactly as documented above — this is a convenience layer in front of
  that gate, not a replacement for it. A REQUEST_CHANGES verdict *does*
  block the push (non-zero exit, same as the existing `pre-commit`
  lint-staged hook) — override with `git push --no-verify` if you disagree
  with a specific finding, same escape hatch as any other husky hook.

**Both diff reviewers are now told to report every finding at once
(2026-08-19), and that instruction is load-bearing.** The prompt used to
say *what* to review for but never that the review had to be exhaustive —
so it returned one finding per round. PR #97 is the worked example: five
rounds, exactly one finding each, and **all four findings already existed
at round one** (verified by re-reading the round-1 diff; none were
introduced by the fixes for earlier rounds). Four sequential round-trips
delivered what a single exhaustive pass could have. The added wording
asks for every finding ordered by severity, prefixed `[High]`/`[Medium]`/
`[Low]`, and explicitly says not to hold anything back for a later round
because the author fixes in batches. Applied to `ai-code-review.mjs`
(pass 1) and the precheck — deliberately *not* to
`ai-ci-results-review.mjs`, whose job is a narrow mechanical check
(skip-logic sanity, do the results look right) rather than an open-ended
hunt. Worth measuring rather than assuming: compare rounds-per-PR after a
few real PRs against the historical counts (#90: 18 blocking reviews,
#94: 14, #97: 4).

**Reasoning effort was raised `low` → `medium` (2026-08-19) to match pass
1, reversing the original latency-over-depth trade.** The `low` setting
was chosen on the theory that a fast heads-up beats a thorough one when
something runs on every push. Measured against real review rounds, that
trades the wrong way: a local pass *weaker* than the CI pass it previews
can only ever miss findings CI then raises, and each miss costs a full CI
round-trip (~4 minutes of jobs plus a review pass) to save roughly 20
seconds of local latency. PR #94 is the worked example — four review
rounds, of which the coverage gap, a `.includes("test")` substring bug in
a database-safety guard, and a hardcoded English metadata title were all
diff-only findings squarely in this precheck's scope. Override per-push
with `PRECHECK_EFFORT` if a specific push genuinely needs speed over
parity.

**The missing-key path is deliberately loud, and deliberately not phrased
as "optional."** It used to print `OPENAI_API_KEY not set locally (this is
optional — export it to enable this precheck)`, which read as routine
informational output — and was scrolled past unnoticed across an entire
session's worth of pushes while CI review rounds kept surfacing findings
this would have caught first. Every *other* skip path here covers a
transient or unavoidable condition (no network, no diff, an unfetched base
ref); this one covers a standing misconfiguration that silently disables
the whole precheck indefinitely, which is a different thing and now reads
like one: a boxed warning naming the actual cost, plus the exact command
to fix it. `PRECHECK_OPTOUT=1` silences it for anyone who genuinely
doesn't want the precheck — an explicit, recorded choice rather than
learning to ignore a warning, since an ignored warning has stopped being a
signal at all. Both paths still exit 0; fail-open is unchanged.

**Has no equivalent to pass 2 at all** — there's no local "does the
skip-logic/CI-results look right" precheck, since none of that exists
yet at push time either; pass 2's whole reason to exist is CI grounding
that a local hook structurally can't have before a push even happens.

Reuses `scripts/lib/review-verdict.mjs` and `scripts/lib/override-
decisions.mjs` unchanged — same tested parsing logic both CI passes use,
not a second copy that could drift from them. The override-decision log
fetch (`gh pr view` → `gh api .../issues/<n>/comments --paginate --slurp`)
is best-effort: if no PR exists yet for the current branch, `gh pr view`
fails and this falls through to empty context, the same fail-open default
either CI job's own "Fetch prior override decisions" step uses when it
can't reach the data.

Verified directly before landing (no real `OPENAI_API_KEY` available in
this working session, so the actual-success path — a real API call
producing a genuine APPROVE/REQUEST_CHANGES — wasn't exercised end to
end; every other path was, for real, not by inspection): the no-key skip,
a real OpenAI 401 on an invalid key correctly failing open, the no-diff
skip (comparing a ref against itself), `decideVerdict`'s four branches
(APPROVE, REQUEST_CHANGES, files-reviewed mismatch override, truncation
override) against the actual imported function, and the override-log
fetch's fail-open path against a real branch with no PR.

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

## Shared configuration (`packages/config`, `@medinstru/config`)

The single source of truth for configuration **values** in this repo: the
web app's runtime values (`API_URL`, `SITE_URL`, `LOCALES`,
`DEFAULT_LOCALE`), the performance budgets, and every AI automation's
settings (model, reasoning effort, input/output limits, and which env var
holds each key). A pnpm workspace package — `packages/*` was already in
`pnpm-workspace.yaml`, so this needed no workspace change.

**What it replaced.** `apps/web/src/lib/config.ts` (now deleted, its four
importers repointed) plus the same literal `gpt-5.6` and `60_000` limit
hardcoded independently in four different scripts. The highest-value catch
was the JS budget: `apps/web/test/bundle-budget.spec.ts` (curl-measured)
and `apps/web/scripts/perf-budget.mjs` (Lighthouse-measured) each declared
their own copy, held in sync only by this file's own "the two must move
together" note — an invariant a human has to remember and eventually
won't. One shared constant makes it structural. The *raise history* stays
in `bundle-budget.spec.ts`'s comment; only the current value moved.

**Plain JS + a hand-written `index.d.ts`, not TypeScript, deliberately.**
Two consumers with incompatible needs: `apps/web` compiles it through
TypeScript and needs real literal types (`LOCALES` feeds a
`(typeof LOCALES)[number]` union that next-intl's routing depends on — a
plain `string[]` would silently widen it and break locale type-safety
app-wide), while `scripts/*.mjs` import it as plain Node ESM with no build
step at all. Runtime JS plus declarations satisfies both without asking
either to compile the other's format.

**API key values must never go in this package**, only the *names* of the
env vars holding them (`apiKeyEnv`). It's committed, so a value written
there enters git history permanently and is readable by every CI job.
Values stay in GitHub repo secrets (CI) and your own shell (local).
`resolveApiKey()` reads by name at call time and its error text names only
the variable, never any part of the value — so a misconfiguration can't
leak a partially-set key into a public CI log. There's a committed test
asserting no role carries a literal key.

**Only 12 config files exist in this repo and 11 of them cannot move
here** — `tsconfig.json`, `eslint.config.mjs`, `next.config.ts`,
`vitest.config.ts`, `playwright.config.ts`, `postcss.config.mjs`,
`prisma.config.ts`, `components.json`, `jest-e2e.json` are tool-owned
entry points, each discovered by its tool at a specific filename in a
specific directory. Relocating one doesn't centralize anything; it makes
the tool fail to find its config. What centralizes is the *values inside
them* — `next.config.ts` importing `LOCALES` from here is the pattern,
not moving `next.config.ts` itself.

**Adding a workspace package to `apps/web` requires three separate
Dockerfile changes plus a `docker-compose.yml` mount — four places, and
three of them fail in ways that don't look related.** See the gotcha
below. Any future package added here needs all four:
1. `deps` stage: `COPY packages/<name>/package.json` (install fails
   loudly without it).
2. `build` stage: `COPY packages packages` (`next build` fails on config
   load).
3. `prod` stage: copy the built package over pnpm's dangling workspace
   symlink (**builds clean, crashes at boot**).
4. `docker-compose.yml`: mount `./packages:/repo/packages` on the `web`
   service (**the dev stack breaks**, since the `dev` stage is `FROM deps`
   and deliberately bakes in no source).

## Known gotchas (already solved once — don't re-derive)

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
`[blocked] Bump typescript from 5.9.3 to 7.0.2` (#27),
`[blocked] Bump eslint from 9.39.5 to 10.8.1` (#24),
`[blocked] Bump @eslint/js from 9.39.5 to 10.0.1` (#25). Rename with
`gh pr edit <number> --title "[blocked] <original title>"` — don't
touch the rest of the title. Remove the prefix once the underlying
blocker actually clears and the PR becomes a normal mergeable bump
again. **Keep `scripts/known-outdated-packages.txt` in sync with this
list** — that's what keeps `dependency-freshness.yml` from permanently
failing on packages nobody can currently fix; add a package's exact npm
name there in the same commit that marks its PR `[blocked]`, and remove
it there too the moment the prefix comes off.

- **PR #27 (`typescript` 5.9.3 → 7.0.2) is blocked upstream — don't
  re-investigate, don't try to force it through.** `typescript-eslint`
  does not support TypeScript 7 at all: `pnpm lint:check` fails outright
  with `typescript-eslint does not support TS 7.0`, and
  `typescript-eslint@latest` (checked directly via `npm view
  typescript-eslint@latest peerDependencies`) still declares `typescript:
  '>=4.8.4 <6.1.0'`. Also checked the `canary` dist-tag specifically
  (`npm view typescript-eslint@canary peerDependencies`) since `@latest`
  alone doesn't cover separately-tagged prereleases — as of `8.67.1-alpha.4`
  it declares the identical range, so there is no newer or prerelease
  version that fixes this yet. Tracked upstream:
  [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
  Merging this bump would permanently break `lint` — a never-path-filtered,
  always-required check — for every future PR. Left open, deliberately
  unmerged, with the conflict against `main` resolved (so it doesn't sit
  in a stale `CONFLICTING` state) but nothing else touched. Before
  attempting this bump again: re-check `typescript-eslint`'s current
  peer-dependency range for `typescript` — once it covers `7.x`, this
  becomes a normal bump like any other Dependabot PR.
- **PR #24 (`eslint` 9.39.5 → 10.8.1) and PR #25 (`@eslint/js` 9.39.5 →
  10.0.1) are both blocked by the same upstream gap — don't
  re-investigate, don't try to force either through.** `eslint-config-next`
  (this repo's `apps/web` lint config, latest is `16.3.1`, already what's
  installed) pulls in `eslint-plugin-react@^7.37.0` as a transitive
  dependency (`pnpm why eslint-plugin-react --filter web`), and that
  plugin crashes under ESLint 10: `TypeError: Error while loading rule
  'react/display-name': contextOrFilename.getFilename is not a function`,
  because the rule-context shape it expects was removed. Confirmed via
  both `npm view eslint-plugin-react@latest peerDependencies` (`eslint:
  '^3 || ... || ^9.7'` — no `^10`) and its `next` dist-tag (`7.8.0-rc.0`,
  itself far older than `latest` and clearly abandoned — no active
  prerelease channel carries a fix yet). The actual fix exists only as an
  open, unmerged upstream PR:
  [eslint-plugin-react#4022](https://github.com/jsx-eslint/eslint-plugin-react/pull/4022)
  ("fix: complete ESLint 10 compatibility"), consolidating
  [#4018](https://github.com/jsx-eslint/eslint-plugin-react/issues/4018).
  **The automated `ai-failure-analysis` comment on this PR is wrong** — it
  suggested bumping to `eslint-plugin-react@^7.38.0`/`^7.39.0`; neither
  version exists on npm (verified directly, `npm view
  eslint-plugin-react@7.38.0` 404s). Treat that job's suggestions as
  unverified, same as always — this is a concrete instance of it
  fabricating a plausible-sounding but nonexistent fix.
  **PR #25 is the same family, not a separate issue**: `@eslint/js` is
  meant to track ESLint's own major version, and its `10.0.1` lockfile
  entry declares a peer of `eslint: ^10.0.0` (optional, which is why
  `lint` doesn't actually crash on this one — apps/api's `eslint` stays
  pinned at `^9.18.0`) — a real, verified, unsupported major-version
  pairing, confirmed by reading `pnpm-lock.yaml` directly, not just
  trusting the AI reviewer's finding on that PR. Before attempting either
  bump again: re-check whether `eslint-config-next` (or
  `eslint-plugin-react` directly) has shipped a version with a peer range
  covering `eslint@^10` — once it has, both become normal bumps like any
  other Dependabot PR, ideally merged together since they're the same major.
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
- **Turbopack's `//# sourceMappingURL` doesn't match the chunk's own
  filename hash** in this Next.js version — `<hash>.js` chunks reference a
  `.js.map` under a *different* hash, unrelated to any `.js` file actually in
  the build output. Lighthouse logs a harmless "mapping for last column out
  of bounds" warning because of this. Not investigated further; if you need
  per-module bundle attribution, don't rely on `source-map-explorer` pointed
  at the obvious `<chunk>.js.map` path — it won't resolve. Grepping the raw
  chunk for library signature strings doesn't work either (fully stripped,
  no license banners, no module-path comments in production output).
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

`apps/api` marks read-only GraphQL GET responses cacheable
(`graphql-cache.ts`, `public, max-age=0, s-maxage=60,
stale-while-revalidate=300, must-revalidate`) so a CDN can serve a
product listing without a trans-Pacific hop to Render.

**The trap, and it is not a hypothetical one: GraphQL reports resolver
failures as HTTP 200 with an `errors` array.** "Did this succeed" is a
property of the BODY, not the status line. The original middleware
replaced `Cache-Control` unconditionally, so an error carried the full
cacheable header — verified live against the deployed API before fixing:

```
{product(id:"does-not-exist-abc"){id}}
→ HTTP/2 200
→ cache-control: public, max-age=0, s-maxage=60, stale-while-revalidate=300
```

Harmless while nothing cached these responses. Behind a CDN it is an
outage amplifier: a one-second database blip is stored at that edge for
`s-maxage`, then served stale for the whole `stale-while-revalidate`
window on top, to every visitor routed through that location — and
there is no purge hook yet to cut it short. A blip becomes a
multi-minute regional outage.

**Why the decision moved to `res.send`, not `res.setHeader` (where it
was) and not `res.end` (the obvious next guess).** Read straight off
Apollo's express integration
(`@as-integrations/express5/dist/cjs/index.js`), which does exactly
this, in this order:

```js
res.setHeader(key, value);          // headers FIRST
res.statusCode = response.status;   // status AFTER them
res.send(response.body.string);
```

So at `setHeader` time the status is still the default 200 and no body
exists — the old wrapper had to decide blind, and decided "cacheable"
every time. `res.send` is the first point where status and complete
body are both final. It is also **before Express's conditional-GET
transform**, which is what makes it the right hook rather than
`res.end`: Express builds a 304 by blanking the body and stripping the
`Content-*` headers while leaving `Cache-Control` alone, so a decision
made at `end` would see an empty body, refuse it, and let Apollo's
`no-store` ride out on the 304 — telling a shared cache to drop an
entry it had just confirmed was still fresh, turning cheap revalidation
into a permanent miss. Deciding at `send` also keeps the outcome
independent of Apollo's internal plugin ordering.

`isCacheableGraphqlResponse` **fails closed in every branch** —
unparseable body, non-object JSON, missing `data`, any `errors` key at
all (including an empty array), absent chunk, any status but 200. Not
caching something cacheable costs one round trip; caching an error
costs an outage.

`Timing-Allow-Origin` is deliberately NOT tied to cacheability — it is
set on every GET. Browsers zero out cross-origin timing data without
it, and a failing request is exactly the one worth measuring from RUM.

**Verified in both directions, not just forwards** (the discipline this
file already requires elsewhere): the two regression tests in
`products.e2e-spec.ts` were run against the *old* middleware and both
failed, then against the new one and both passed — real HTTP through
the real Apollo+Express stack, not a mocked response. The 304 assertion
is the guard on the `send`-vs-`end` placement specifically; it passes
under both, so it protects the fix rather than proving the bug.

**This pairs with a specific Cloudflare Cache Rule** — see
[docs/cloudflare.md](./docs/cloudflare.md). Two settings there are
load-bearing and neither is the default:
- The match must use `http.request.uri.path`, **not** `http.request.uri`
  — the latter includes the query string, so it never equals `/graphql`
  and the rule silently matches nothing.
- Edge TTL must be *"Use cache-control header if present, bypass cache
  if not"* (`respect_origin`). The neighbouring option caches responses
  that arrive *without* a cache-control header using Cloudflare's own
  defaults — precisely the path an unexpected error takes. With
  `respect_origin`, errors now carrying Apollo's `no-store` are bypassed
  automatically, so no error-specific edge rule is needed.

**Before login exists, revisit this.** These queries are anonymous and
sent with `credentials: "omit"`, which is the only reason a shared
cache is safe here at all. An authenticated response must never be
edge-cached — that needs `private, no-store` keyed off the request
carrying credentials, and it must land before the first authenticated
query ships, not after.

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
The managed rules are appended after that inventory and include both an
anonymous-GET eligibility rule and a final explicit bypass for authenticated,
cookie-bearing, or non-GET GraphQL requests; the bypass is what neutralizes an
earlier imported rule that was broader than intended. It is the exact
complement of the eligibility condition across the whole API hostname, so
every other API path is bypassed too; only the exact canonical `/graphql` path
with an anonymous, cookieless GET is cache-eligible.

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
