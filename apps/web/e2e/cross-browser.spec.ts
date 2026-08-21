import { test, expect, type ConsoleMessage, type Request } from "@playwright/test";

// Runs on every tier-1 engine and on real mobile device profiles. Everything
// else in e2e/ runs on Chromium only.
//
// WHY THIS FILE IS SEPARATE rather than running the whole suite everywhere:
// critical-flow.spec.ts asserts screenshots, and baselines are per-project.
// Running it on five projects would mean five sets of Linux-generated
// baselines to regenerate on every intentional UI change -- a large,
// permanent maintenance cost for a small increase in real coverage. This
// file carries no screenshots, so it costs one extra page load per project.
//
// WHAT IT LOOKS FOR, which is what a device lab is actually useful for:
// engine-specific rendering failures, uncaught script errors, and failed
// network requests. Those are the things that differ between engines;
// business logic does not.

/** Requests that failed for a reason that is normal, not a defect. */
function isBenignFailure(request: Request): boolean {
  const failure = request.failure()?.errorText ?? "";
  const url = request.url();

  // Next.js prefetches route payloads on viewport entry and aborts the
  // loser when two prefetches race or one is superseded. DevTools renders
  // that as a failed request; it is by design and costs nothing.
  //
  // Observed live on production: two `?_rsc=` requests for the same product,
  // one 200 and one net::ERR_ABORTED. Failing on it would make this suite
  // red for correct behaviour.
  if (/_rsc=/.test(url) && /ABORTED/i.test(failure)) return true;

  // A cancelled navigation-triggered request when the test ends.
  if (/ABORTED/i.test(failure) && request.isNavigationRequest()) return true;

  return false;
}

/** Console output that is noise rather than a defect. */
function isBenignConsoleError(message: ConsoleMessage): boolean {
  const text = message.text();
  // The catalogue is fetched client-side; if the API is briefly unreachable
  // the page renders its error state by design. That is a different test's
  // concern, not an engine-compatibility signal.
  return /Failed to fetch|NetworkError|ERR_CONNECTION/i.test(text);
}

test.describe("tier-1 engine and device health", () => {
  test("renders real catalogue content, not just the shell", async ({ page }) => {
    // The shell rendering while products silently fail is the exact shape
    // of the service-worker outage: header and footer present, catalogue
    // empty, nothing obviously broken. Assert on real product content.
    await page.goto("/en");

    await expect(page.locator('[data-slot="card"]').first()).toBeVisible({
      timeout: 20_000,
    });

    const headings = page.locator("h2");
    expect(await headings.count()).toBeGreaterThan(0);

    const firstTitle = (await headings.first().innerText()).trim();
    expect(firstTitle.length).toBeGreaterThan(0);
  });

  test("produces no uncaught script errors", async ({ page }) => {
    // pageerror is an *uncaught* exception, which is engine-specific in a
    // way console noise is not: an unsupported API or a syntax feature the
    // engine does not implement surfaces here and nowhere else.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !isBenignConsoleError(message)) {
        consoleErrors.push(message.text());
      }
    });

    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible({
      timeout: 20_000,
    });

    expect(pageErrors, `uncaught errors: ${pageErrors.join(" | ")}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
  });

  test("issues no genuinely failed network requests", async ({ page }) => {
    const failures: string[] = [];
    page.on("requestfailed", (request) => {
      if (isBenignFailure(request)) return;
      failures.push(`${request.url()} — ${request.failure()?.errorText}`);
    });

    // Non-2xx responses matter too: requestfailed only fires for transport
    // failures, so a 404 on a stylesheet or an image would pass silently.
    const badStatuses: string[] = [];
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 400) badStatuses.push(`${status} ${response.url()}`);
    });

    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible({
      timeout: 20_000,
    });

    expect(failures, `failed requests: ${failures.join(" | ")}`).toEqual([]);
    expect(badStatuses, `error responses: ${badStatuses.join(" | ")}`).toEqual([]);
  });

  test("does not overflow horizontally at this viewport", async ({ page }) => {
    // The highest-value layout assertion for a device matrix, and one that
    // is fully deterministic: horizontal overflow on a phone is a real,
    // visible defect (the page scrolls sideways, content is cut off) and it
    // is exactly what a desktop-only suite never sees.
    //
    // A pixel of slack absorbs sub-pixel rounding in layout widths, which
    // differs between engines without being a bug.
    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible({
      timeout: 20_000,
    });

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    expect(
      overflow.scrollWidth,
      `page scrolls horizontally: content ${overflow.scrollWidth}px wide in a ${overflow.innerWidth}px viewport`,
    ).toBeLessThanOrEqual(overflow.innerWidth + 1);
  });

  test("reports load timing for this engine", async ({ page }) => {
    // Recorded, not asserted. Cross-engine timing on a shared CI runner is
    // exactly the kind of measurement that made LCP a 70%-failure gate, and
    // this suite runs on five projects rather than one. The number is
    // useful in the log when an engine is visibly slower; turning it into a
    // budget would produce noise, not signal.
    await page.goto("/en");
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible({
      timeout: 20_000,
    });

    const timing = await page.evaluate(() => {
      const [nav] = performance.getEntriesByType(
        "navigation",
      ) as PerformanceNavigationTiming[];
      return nav
        ? {
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd),
            transferSize: nav.transferSize,
          }
        : null;
    });

    console.log(`[timing] ${test.info().project.name}: ${JSON.stringify(timing)}`);
    expect(timing).not.toBeNull();
  });
});
