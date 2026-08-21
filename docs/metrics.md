# Badges and the metrics dashboard

How coverage, Lighthouse and accessibility badges are published to `gh-pages`, and how to add a new metric.

Extracted from CLAUDE.md, which keeps a pointer here. Operating
rules live there; this file is the reference.

---

`scripts/publish-badge.sh <name> <path-to-json-file> [pct] [commit-sha]`
publishes a shields.io "endpoint" badge JSON to `coverage/<name>-badge.json`
on the `gh-pages` branch (README's badges read these live via
`raw.githubusercontent.com` — no third-party badge service/account needed).
Bootstraps `gh-pages` as an orphan branch on first run if it doesn't exist;
retries on push conflict (another job racing to update a different file on
the same branch) with a jittered backoff. When `pct`/`commit-sha` are
passed, it also appends `{date, commit, pct}` to
`coverage/<name>-history.json` **unconditionally** — even when the value is
unchanged from last time, since a time-series chart needs a data point on
every measurement or an unchanged stretch shows as a gap instead of a flat
line. Every run also syncs `scripts/coverage-dashboard/{index.html,
chart-math.mjs}` (version-controlled on `main`) to `coverage/` on
`gh-pages` — **both files, every time**; a real bug once shipped with only
`index.html` synced, silently breaking the dashboard's `import` (see
`publish-badge.test.sh`, which now asserts both are present after a
publish).

Three metrics currently flow through this: `api`/`web` coverage (published
from `ci.yml`'s `test-api-unit`/`test-web` jobs, main-only, gated on
`if: github.ref == 'refs/heads/main' && github.event_name == 'push'` — an
in-progress PR's coverage never overwrites the badge before it merges) and
`lighthouse` (published from the `perf-budget` job). The Lighthouse one is
deliberately different: it publishes with `if: always()` (still scoped to
push-to-main) rather than only on success, because going under budget is a
**hard failure** for that job — freezing the badge/history at the last
*passing* score would hide the exact regression the dashboard exists to
show. The required-check behavior (blocking a PR until the budget is met)
is unaffected by this — that's `perf-budget`'s own exit code, not the
publish step.

The dashboard itself (`coverage/index.html` on `gh-pages`, live at
https://nixsin.github.io/marketplace/coverage/index.html) is a
self-contained static page — no build step, no external JS/CSS — that
fetches each `<name>-history.json` and renders a hand-rolled SVG line
chart per metric. The chart math (layout, gridlines, stats) lives in
`scripts/coverage-dashboard/chart-math.mjs`, imported by `index.html` as a
real ES module (`<script type="module">`) — verified empirically that
GitHub Pages serves `.mjs` as `text/javascript`, so this isn't relying on
an unverified assumption about the deploy environment. `chart-math.mjs`
has its own test suite (`chart-math.test.mjs` — empty/single-point/
0%-or-100%-boundary/multi-point cases), run in `ci.yml`'s `test-ci-scripts`
job alongside `publish-badge.test.sh` (exercises the history-append/
retry-safe-push behavior against a local bare git repo via a
`PUBLISH_BADGE_REPO_URL` test-only override).

**Adding a new metric**: call `publish-badge.sh <new-name> <json-file> [pct] [sha]`
from the relevant CI job (same pattern as the three above), add a
`<a href="<new-name>-history.json">` link + a `<div class="panel">` +
`renderChart(...)` call to `scripts/coverage-dashboard/index.html`, and a
README badge line pointing at `coverage/<new-name>-badge.json`. No changes
needed to `publish-badge.sh` or `chart-math.mjs` — both are already fully
generic over the metric name. **The job doing the publishing needs its own
`permissions: contents: write` block** (repo default is read-only — see
"Known gotchas" below) — add it even if the job already exists for other
reasons and even though a PR adding this can't verify it directly: the
publish step only runs on `push` to `main`, never on `pull_request`, so
the introducing PR's own CI can't exercise it either way. Missing this
has now caused a real, deterministic post-merge 403 twice (`perf-budget`,
then `test-e2e-web` for the `accessibility` metric) — don't let it be a
third.

**`accessibility` (2026-08-17)** — the fourth metric, added by following
this exact recipe. Published from `test-e2e-web`'s "Publish accessibility
badge" step, `always()`-gated the same way Lighthouse's own publish step
is (a real violation must still show up, not freeze the badge at the
last passing run) but *also* genuinely conditional on `push`-to-`main` —
skips cleanly with no result files when `accessibility.spec.ts` didn't
run this push at all (an API-only change, per the test-selection scoping
in the Web e2e section below), which is a gap, not a failure. Binary, not
a partial score: `pct` is 100 when `accessibility.spec.ts` found zero
violations across both `/en` and `/hi`, 0 otherwise — deliberately stored
on the same 0-100 scale the other metrics use (so it reuses the identical
chart/badge machinery) rather than inventing a new unit for what's really
a pass/fail signal. Each test writes its own violation count to a
uniquely-named file (`accessibility-en.json` / `accessibility-hi.json`
under `$ACCESSIBILITY_RESULT_DIR`) rather than a single shared file with
read-modify-write — Playwright runs these tests in parallel workers
(`fullyParallel: true`), and a shared file would race.
