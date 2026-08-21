import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "./route";
import { API_URL, BUILD_COMMIT, BUILD_TIME, SITE_URL } from "@medinstru/config";

describe("GET /version", () => {
  it("reports the build identity and the two build-time URLs", async () => {
    // apiUrl and siteUrl are here because each has caused a real incident
    // that took real time to diagnose: a restart that reused an old image
    // and kept calling the retired API host, and a build that shipped with
    // SITE_URL unset so every share link pointed at localhost.
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      commit: BUILD_COMMIT,
      buildTime: BUILD_TIME,
      apiUrl: API_URL,
      siteUrl: SITE_URL,
    });
    expect(Date.parse(body.servedAt)).not.toBeNaN();
  });

  it("is never cacheable", async () => {
    // A deploy-identity endpoint that can be cached will eventually report
    // a build that is no longer running -- worse than no endpoint at all,
    // because it asserts something false with apparent authority.
    const cacheControl = (await GET()).headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-store");
  });

  it("is excluded from next-intl's locale rewriting", async () => {
    // THE TRAP THIS GUARDS. proxy.ts's matcher skips anything containing a
    // dot, which is why /robots.txt and /sitemap.xml reach their handlers.
    // /version has no extension, so without being named explicitly it gets
    // rewritten to /en/version and 404s -- while route.ts sits there
    // looking entirely correct.
    const proxy = readFileSync(
      join(__dirname, "..", "..", "proxy.ts"),
      "utf8",
    );
    const matcher = proxy.match(/matcher:\s*\["([^"]+)"\]/)?.[1];
    expect(matcher, "could not read the matcher from proxy.ts").toBeDefined();
    expect(
      matcher,
      "/version must be excluded from the locale matcher or it 404s",
    ).toContain("version");
  });
});
