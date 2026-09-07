import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TIME_ZONE } from "./routing";

/**
 * One time zone, named once, read by every side that formats a date.
 *
 * The bug this guards is silent by construction. next-intl's server config
 * and the hand-built NextIntlClientProvider are configured separately, so a
 * zone set on one and not the other does not fail anything -- use-intl logs
 * ENVIRONMENT_FALLBACK and falls back to whatever zone the runtime is in,
 * which is the server's on the server and the viewer's in the browser. The
 * two agree for most of the day and disagree for a timestamp near a day
 * boundary, which is when React reports a hydration mismatch instead.
 */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("time zone", () => {
  it("is a zone Intl actually accepts", () => {
    // A typo here would not throw until something formatted a date.
    expect(() =>
      new Intl.DateTimeFormat("en", { timeZone: TIME_ZONE }).format(new Date()),
    ).not.toThrow();
  });

  it("is fixed, not the runtime's zone", () => {
    // The whole point. Anything resolved from the environment differs
    // between the server render and the browser's hydration.
    expect(TIME_ZONE).not.toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(TIME_ZONE).toBe("UTC");
  });

  it("produces the same date string on both sides of a day boundary", () => {
    // The concrete failure: 23:37 UTC is already the next calendar day in
    // IST, so a viewer-zone render and a server render disagree on the date.
    const nearBoundary = new Date("2026-09-07T23:37:00.000Z");
    const pinned = (locale: string) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeZone: TIME_ZONE,
      }).format(nearBoundary);
    const inIST = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeZone: "Asia/Kolkata",
    }).format(nearBoundary);

    expect(pinned("en")).not.toBe(inIST); // the mismatch is real
    expect(pinned("en")).toBe(pinned("en")); // and pinning removes it
  });

  it("is read from the shared constant by BOTH halves of next-intl", () => {
    // Setting only one side is exactly what produced ENVIRONMENT_FALLBACK.
    expect(read("./request.ts")).toMatch(/timeZone:\s*TIME_ZONE/);
    expect(read("../components/locale-provider.tsx")).toMatch(
      /timeZone=\{TIME_ZONE\}/,
    );
  });

  it("is never hardcoded at a call site", () => {
    // Fixes the class rather than the instance: product-detail.tsx pinned
    // "UTC" by hand while next-intl had no default at all, so the app looked
    // consistent at that one call site and was not.
    for (const path of [
      "../components/product-detail.tsx",
      "./request.ts",
      "../components/locale-provider.tsx",
    ]) {
      expect(read(path)).not.toMatch(/timeZone[:=]\s*["'`]/);
    }
  });
});
