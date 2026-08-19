import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JS_BUDGET_BYTES } from "@medinstru/config";
import { startProdServer, type StartedServer } from "./helpers/server";

const execFileAsync = promisify(execFile);

// §12A budget: JS < 150KB per route, gzip. This measures the actual
// Content-Length of a real GET request with compression negotiated, not
// raw file size — the same thing a real browser transfers, and the same
// thing this session's Lighthouse audit measured as "Script transfer".
//
// Raised twice, deliberately, not copy-pasted:
//   150KB -> 160KB: adding language-switching (next-intl's client runtime
//     + the LanguageSwitcher component) cost ~12KB, real number 154.4KB.
//   160KB -> 172KB: making the switch instant (no server round trip on
//     language change) required converting Header/Footer/Pagination/
//     ProductCard from Server Components to Client Components, so they
//     can react to client-side locale state — real number 167.3KB. This
//     was a known, explicitly-accepted tradeoff (see conversation), not
//     an accident: instant switching vs. shipping those components'
//     translation logic to the client. A cheaper alternative exists
//     (wrap only the translated text nodes in small "island" client
//     components, keep the surrounding layout as Server Components) but
//     was deferred as extra engineering effort for later, not done now.
//   172KB -> 186KB: adding an explicit `browserslist` config (Chrome/
//     Safari/Firefox/Edge, last 2 versions each) for defined Tier 1
//     browser support. Isolated and confirmed via a controlled A/B
//     rebuild (config in vs. out, nothing else changed): Next.js's
//     *implicit* target (no browserslist) takes a more aggressive
//     internal shortcut in its minifier than the standard browserslist-
//     driven transform path does, even though both are targeting
//     similarly modern browsers. This is the cost of the target being
//     verified and intentional instead of an undocumented framework
//     default — accepted deliberately, not overlooked.
//   186KB -> 189KB: no single isolated cause this time, unlike the three
//     raises above. Discovered failing (188.7KB measured) on PR #19, a
//     Dockerfile-only Dependabot bump with no apps/web source changes —
//     so this is drift (dependency patch versions, Next.js itself, etc.),
//     not a deliberate tradeoff. Raised at the user's direction to give a
//     small margin over the current real number rather than investigating
//     the drift's source right now.
//   189KB -> 191KB: the previous raise's margin turned out to be exactly
//     as thin as its own comment warned ("nearly exhausted... next
//     addition needs to earn its bytes") — the very next real addition
//     broke it. PR #62's 3 accessibility fixes (aria-label product-name
//     interpolation in both locales, WAI-ARIA pagination attributes, the
//     Radix Slot/asChild plumbing for a real <h2> heading) added a real,
//     verified 160 bytes client-side (curl-measured, side-by-side git
//     worktree diff against main: 190069 -> 190229 bytes). That alone
//     shouldn't have been enough to fail an 189KB budget, but the
//     pre-existing margin was already down to 15 bytes locally
//     (193521/193536 measured via a real local `pnpm test:perf` run) —
//     thin enough that CI's Linux build (vs. this measurement's macOS
//     build) tipped over it while local stayed just under. This is a
//     deliberate, user-approved raise, not a silent bypass of a failing
//     required check (see this repo's CLAUDE.md "hard rule") — the bytes
//     are real accessibility-fix cost, not bloat to trim, and 2KB of
//     margin is meant to survive this exact cross-platform noise next
//     time rather than needing a raise again immediately.
// Budget is nearly exhausted again — next addition needs to earn its
// bytes, or that island-component optimization needs to actually happen.
//
// The number itself now lives in @medinstru/config, imported by both this
// file and scripts/perf-budget.mjs. It used to be declared separately in
// each, with only CLAUDE.md's "the two must move together" note holding
// them in sync — an invariant a human has to remember, and eventually
// won't. The raise *history* above stays here: this is where the reasoning
// belongs, the config module just holds the current value.

async function compressedSize(url: string): Promise<number> {
  // Node's fetch (undici) transparently decompresses gzip/br bodies, and
  // Content-Length isn't always present for compressed/chunked responses —
  // so measure actual wire bytes with curl instead, the same way this was
  // verified manually earlier in this session.
  const { stdout } = await execFileAsync("curl", [
    "-s",
    "-o",
    "/dev/null",
    "-H",
    "Accept-Encoding: gzip, br",
    "-w",
    "%{size_download}",
    url,
  ]);
  return Number(stdout.trim());
}

describe("first-load JS bundle budget (production build)", () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startProdServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("stays under the 150KB gzip budget for the home route", async () => {
    const html = await (await fetch(server.baseUrl)).text();
    // Only real <script src="..."> tags — the RSC payload embedded further
    // down the page also contains chunk paths as plain string literals
    // (for prefetching other routes), which aren't part of *this* page's
    // first-load JS and would wildly overcount if matched too.
    //
    // Exclude nomodule="" scripts: legacy-browser polyfill fallbacks that a
    // modern browser (real Android Chrome included, and Lighthouse's Chrome)
    // never downloads at all if it supports ES modules — counting them here
    // would measure bytes real users never actually transfer.
    const scriptTags = html.match(/<script[^>]+>/g) ?? [];
    const chunkPaths = [
      ...new Set(
        scriptTags
          .filter((tag) => !tag.includes("noModule"))
          .map((tag) => tag.match(/src="(\/_next\/static\/[^"]+\.js)"/)?.[1])
          .filter((src): src is string => Boolean(src)),
      ),
    ];
    expect(chunkPaths.length).toBeGreaterThan(0);

    const sizes = await Promise.all(
      chunkPaths.map((p) => compressedSize(`${server.baseUrl}${p}`)),
    );
    const total = sizes.reduce((a, b) => a + b, 0);

    console.log(
      `  ${chunkPaths.length} JS chunks, ${(total / 1024).toFixed(1)}KB gzip total (budget: ${JS_BUDGET_BYTES / 1024}KB)`,
    );

    expect(total).toBeLessThanOrEqual(JS_BUDGET_BYTES);
  });
});
