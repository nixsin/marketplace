# Web end-to-end and accessibility testing

What `test-e2e-web` covers, why it is Chromium-only for now, and the accessibility findings axe-core could not have caught.

Extracted from CLAUDE.md, which keeps a pointer here. Operating
rules live there; this file is the reference.

---

The first test in this repo that runs in a real browser engine at all —
every other web test (`apps/web/src/**/*.spec.tsx`,
`apps/web/test/*.spec.ts`) is a Vitest/jsdom component test, which never
executes real browser code. `apps/web/e2e/critical-flow.spec.ts` covers
the one substantive flow that actually exists in the UI today: home page
→ real product listing (a genuine GraphQL call to a real API against real
seeded Postgres data, not mocked) → pagination → language switch. There's
no login/onboarding UI yet — that flow is API-only so far (see
`apps/api/test/auth.e2e-spec.ts`) — so don't assume this suite covers it;
extend it here once that UI exists.

**Chromium only, deliberately** — this closes the "zero real-browser
coverage" gap first. A full BrowserStack-style cross-browser/OS device
matrix was considered and rejected as premature: cross-browser testing
multiplies an *existing* single-browser suite, and there wasn't one.
Playwright's other bundled engines (Firefox, WebKit) are the natural next
step once this proves valuable — free, no paid service, no new CI
infrastructure. A real device farm (BrowserStack/Sauce Labs) is worth it
once there are real users on diverse devices and a track record of bugs
slipping past that — not before. shadcn/Radix (this repo's actual
component library) is also specifically built for cross-browser
consistency, which lowers the real risk being deferred here.

**Now a required check** (it began informational, on the same
prove-it-first track `perf-budget` followed). Path-filtered on `api`,
`web`, *and* `deps` — unlike `test-web` (`web`/`deps` only), this suite is a genuine
full-stack integration test, not a mocked component-test suite: its
pagination assertion exercises real `apps/api` logic (`findPaged`'s
Prisma queries), so an API-only change needs to run it too. A docs-only
PR still never pays for it.

**Screenshots use Playwright's built-in `toHaveScreenshot()`** — baselines
live in `apps/web/e2e/critical-flow.spec.ts-snapshots/`, committed to the
repo (platform-suffixed filenames, e.g. `-chromium-darwin.png`; CI runs on
Linux, so the *real* baselines a PR is checked against are Linux-generated
— regenerate with `pnpm --filter web exec playwright test
--update-snapshots` inside the same environment CI uses, not by copying
local macOS-generated PNGs over the repo's Linux ones). A real diff fails
the assertion and Playwright writes `-actual`/`-expected`/`-diff` PNGs
into `test-results/` — verified this mechanism directly (deliberately
swapped a baseline to simulate a regression, confirmed a real diff image
was produced highlighting the changed region, then restored the correct
baseline) before relying on it. Right now a failure's diff images are
only reachable via the uploaded `playwright-report` workflow artifact (a
human has to download and open it) — the planned improvement is posting
the before/after images directly to the PR as a comment, with an AI-
generated description of what visually changed, instead of requiring a
report download. Not built yet; this section will be extended once it
is.

**Local server startup, not Playwright's own `webServer` config, in
CI** — `playwright.config.ts`'s `webServer` block only activates for a
plain local `pnpm test:e2e` (no `PLAYWRIGHT_BASE_URL` set). The CI job
builds and starts both the API (real prod-style build, `node
dist/src/main.js`, matching `load-test.mjs`'s own approach — not `nest
start --watch`, which behaves differently) and the web app itself as
separate steps with their own curl-retry-loop readiness checks, so both
servers' logs stay visible in the job output instead of being buried
inside Playwright's own webServer log capture.

**Local `pnpm test:e2e` still needs Postgres + the API running
yourself** — an AI review round caught that `webServer.command` was
just `pnpm start`, which has nothing to serve on a fresh checkout with
no prior `.next` build; fixed to `pnpm build && pnpm start` (confirmed
by reproducing the original failure directly: `rm -rf .next && pnpm
test:e2e`). What's still deliberately not automated: starting Postgres
or the API — same prerequisites docs/development.md's "Testing" section
already assumes for `apps/api`'s own e2e suite, not a new pattern. Run
`scripts/dev.sh` (or start the API by hand) first.

**Accessibility checks (`e2e/accessibility.spec.ts`) live in this same
job, not a separate one.** Uses `@axe-core/playwright` against the app's
one real page (`src/app/[locale]/page.tsx` — genuinely the only route
that exists right now, so testing `/en` and `/hi` is full UI-surface
coverage, not a partial sample), checking the `wcag2a`/`wcag2aa`/
`wcag21a`/`wcag21aa` rule tags. Deliberately not split into its own CI
job: `playwright.config.ts`'s `testDir: "./e2e"` has no narrower
`testMatch`, so any `*.spec.ts` file placed here is automatically picked
up by the existing job — a separate job would duplicate the entire
build+Postgres+API+web-server setup just to isolate one spec file, for
no real benefit; `describe`/test names already make an accessibility
failure clearly attributable in the log without needing a separate
check-bucket name. If a genuinely separate job is ever
justified (e.g. a much heavier a11y suite, or wanting independent
required-check status later), split it out then — not preemptively.

Axe-core's own stated limitation: it catches roughly 30-50% of WCAG
issues automatically (contrast, missing labels/alt text, ARIA misuse,
landmark structure) — it is not a substitute for manual testing
(keyboard-only navigation, screen readers). A real audit (2026-08-17)
found zero automated violations on both locales; supplemented with a
manual keyboard-focus check (tabbed through the page, confirmed visible
focus rings via the existing global `outline-ring/50` rule) and a check
that icon-only controls (the mobile menu button) expose a real accessible
name, not just an icon. Both real Radix/shadcn defaults, not something
this repo added — worth knowing before assuming a clean axe run means
the UI is fully accessible.

**Three real findings axe-core's clean run missed entirely, surfaced by
live follow-up questions the same day, not by any tool:**
1. **`ProductCard`'s title was a styled `<div>` (`CardTitle`'s default
   tag), not a real heading.** Visually identical to a heading, but
   invisible to a screen reader's "jump between headings" navigation —
   one of the most common ways to skim a listing page. Axe-core can't
   catch this class of gap; it requires knowing something *should* be a
   heading, not just checking whether existing headings are well-formed.
   Fixed by adding `asChild` (Radix `Slot`, same pattern `Badge` already
   uses) to `CardTitle` and rendering a real `<h2>` in `ProductCard` —
   verified via the real accessibility tree (`heading "..."` appearing
   for each product, not `generic`) and a pixel-diff screenshot
   comparison, which caught a *second*, real bug from the same fix:
   `CardTitle`'s own `leading-snug` base class is silently dropped by
   `tailwind-merge` whenever a caller's `text-size` utility conflicts
   with it (already true for the old `<div>` too, just invisible there)
   — but the resulting *fallback* line-height differs by tag (div vs h2),
   which a real Docker/Linux Playwright run caught as a genuine ~5.5px
   layout shift compounding down the page. Fixed with an explicit
   `leading-7` override restoring the exact line-height the shipped div
   version always actually rendered at — confirmed via direct DOM
   measurement (`getBoundingClientRect().height`), not assumed from the
   className alone.
2. **The disabled "Previous" pagination control had no role at all.**
   `<a>` has no native `disabled` attribute, so `pagination.tsx` rendered
   it as a bare `<span>` when inactive — confirmed live via the real
   accessibility tree: `generic "Previous"`, indistinguishable from
   stray page text, versus its enabled siblings' `link "N"`. WAI-ARIA
   APG's documented pattern for exactly this (a link with no native
   disabled state) is to keep the original role and add
   `aria-disabled="true"` rather than drop the role entirely — applied
   here, plus `aria-current="page"` on the active page number (the same
   APG pagination pattern), which was simply missing.
3. **Every "Send Inquiry" button had the identical accessible name.**
   Tab correctly skips static content (title/description/image) by
   design — that's normal, expected browser behavior, not a bug — but
   the consequence here is that a card's *only* interactive element is
   its button, and "Send Inquiry" alone gives a screen-reader user no
   way to tell which product it's for once they've tabbed directly to
   it. A real WCAG 2.4.4 (Link Purpose in Context) issue axe-core
   doesn't reliably flag, since it requires recognizing that N
   *technically*-labeled buttons are ambiguous *in aggregate*, not
   examining one in isolation. Fixed with an `aria-label` carrying the
   product name (new `sendInquiryAbout` translation key, both locales)
   while leaving the visible button text unchanged — confirmed via the
   real DOM (`aria-label` present, `textContent` still exactly "Send
   Inquiry") in both languages.

All three verified against real computed DOM/accessibility-tree state,
not assumed from the diff — matching this repo's own established
"verify, don't just trust the plausible-looking fix" discipline for
everything else in this file.

**Accessibility tests only actually run for changes that could plausibly
affect the UI — not merely whenever the job itself runs.** The whole
`test-e2e-web` job stays gated on `api-or-web-or-deps` (not `web-or-deps`
alone), because `critical-flow.spec.ts`'s pagination test genuinely
exercises real `apps/api` logic (`findPaged`) and needs API-only changes
to trigger it too. But `accessibility.spec.ts` only checks static markup/
contrast/ARIA, never API behavior — an API-only change has no reason to
re-verify it. Since both spec files run inside this one job, scoping
happens at the *test-selection* level inside the "Run Playwright e2e
suite" step, not via a second job: `pnpm exec playwright test`
(everything) when `web` or `deps` changed, `pnpm exec playwright test
e2e/critical-flow.spec.ts` (accessibility skipped) otherwise. A
`workflow_dispatch` force-run always gets the full suite regardless —
if something disagreed with the path filter enough to force this job to
run at all, that's a request for full coverage, not a partial one. A
second CI job was deliberately rejected here too, same reasoning as
above: it would duplicate the entire Postgres+API+web-server setup just
to skip two ~2-second checks, for no real time savings given the job
already has to run that full setup for API-only changes anyway.
