import { describe, expect, it } from "vitest";
import { siteUrlErrorMessage, siteUrlProblem } from "./site-url";

describe("siteUrlProblem", () => {
  it("accepts a real public origin", () => {
    expect(siteUrlProblem("https://medinstru-web.onrender.com")).toBeNull();
    expect(siteUrlProblem("https://laxair.shop")).toBeNull();
    expect(siteUrlProblem("http://staging.example.com:8080")).toBeNull();
  });

  it("rejects an unset or blank value", () => {
    // The original production bug: never set at all.
    expect(siteUrlProblem(undefined)).toBe("it is not set");
    expect(siteUrlProblem(null)).toBe("it is not set");
    expect(siteUrlProblem("")).toBe("it is not set");
    expect(siteUrlProblem("   ")).toBe("it is not set");
  });

  it("rejects a value that is not a URL at all", () => {
    expect(siteUrlProblem("not a url")).toMatch(/not a valid URL/);
    expect(siteUrlProblem("medinstru-web.onrender.com")).toMatch(/not a valid URL/);
  });

  it("rejects a non-http scheme", () => {
    // Parses fine, but nothing that renders a share link or fetches an
    // og:image would follow it.
    expect(siteUrlProblem("ftp://example.com")).toMatch(/must be an http\(s\) URL/);
    expect(siteUrlProblem("file:///tmp/site")).toMatch(/must be an http\(s\) URL/);
  });

  it.each([
    "http://localhost:3000",
    "https://localhost",
    "http://127.0.0.1:3000",
    "http://0.0.0.0:3000",
    "http://[::1]:3000",
  ])("rejects the local address %s, which no recipient can open", (value) => {
    // Checking only for absence would let every one of these through while
    // producing exactly the dead links the guard exists to prevent.
    expect(siteUrlProblem(value)).toMatch(/local address/);
  });

  it("does not mistake a hostname that merely contains 'localhost'", () => {
    // Anchored matching: a real deployment could legitimately be called
    // this, and refusing to build would be a false positive that blocks a
    // valid deploy.
    expect(siteUrlProblem("https://localhost.medinstru.com")).toBeNull();
    expect(siteUrlProblem("https://my-localhost-proxy.example.com")).toBeNull();
  });

  it("trims surrounding whitespace rather than failing on it", () => {
    expect(siteUrlProblem("  https://laxair.shop  ")).toBeNull();
  });
});

describe("siteUrlErrorMessage", () => {
  it("states the specific problem and how to fix it", () => {
    // A deploy blocked at 2am should not require reading the source to
    // work out what went wrong.
    const message = siteUrlErrorMessage(siteUrlProblem("http://localhost:3000")!);
    expect(message).toContain("local address");
    expect(message).toContain("Render dashboard");
    expect(message).toContain("inlined at build time");
  });
});
