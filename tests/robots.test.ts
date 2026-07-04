import { describe, expect, it } from "vitest";
import { isDisallowed, parseRobotsTxt } from "../src/checks/seo/robots.js";

describe("parseRobotsTxt", () => {
  it("collects disallow/allow rules from the wildcard group and sitemap lines", () => {
    const robots = parseRobotsTxt(`# comment
User-agent: googlebot
Disallow: /google-only

User-agent: *
Disallow: /private
Allow: /private/ok
Crawl-delay: 1

Sitemap: https://example.com/sitemap.xml
`);
    expect(robots).toEqual({
      wildcardDisallows: ["/private"],
      wildcardAllows: ["/private/ok"],
      sitemaps: ["https://example.com/sitemap.xml"],
    });
  });

  it("handles multiple user-agents sharing one group and empty disallow", () => {
    const robots = parseRobotsTxt(`User-agent: googlebot
User-agent: *
Disallow:
Disallow: /admin
`);
    expect(robots.wildcardDisallows).toEqual(["/admin"]);
  });

  it("ends the wildcard group when a new group starts after directives", () => {
    const robots = parseRobotsTxt(`User-agent: *
Disallow: /a

User-agent: googlebot
Disallow: /b
`);
    expect(robots.wildcardDisallows).toEqual(["/a"]);
  });

  it("returns empty structures for junk input", () => {
    expect(parseRobotsTxt("%%%\nnot robots at all")).toEqual({
      wildcardDisallows: [],
      wildcardAllows: [],
      sitemaps: [],
    });
  });
});

describe("isDisallowed", () => {
  const robots = parseRobotsTxt(`User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /wild*card
`);
  it("prefix-matches literal disallow rules", () => {
    expect(isDisallowed("https://example.com/private/page", robots)).toBe(true);
    expect(isDisallowed("https://example.com/public", robots)).toBe(false);
  });
  it("applies longest-match allow precedence", () => {
    expect(isDisallowed("https://example.com/private/public/page", robots)).toBe(false);
  });
  it("skips wildcard patterns conservatively", () => {
    expect(isDisallowed("https://example.com/wildXcard", robots)).toBe(false);
  });
  it("treats blanket Disallow: / as blocking everything", () => {
    const blanket = parseRobotsTxt("User-agent: *\nDisallow: /\n");
    expect(isDisallowed("https://example.com/", blanket)).toBe(true);
    expect(isDisallowed("https://example.com/anything", blanket)).toBe(true);
  });
});
