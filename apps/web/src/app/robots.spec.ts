import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots metadata", () => {
  it("allows public crawling and advertises the sitemap index", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "http://localhost:3000/sitemap.xml",
    });
  });
});
