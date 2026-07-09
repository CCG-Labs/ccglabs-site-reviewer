import { describe, expect, it } from "vitest";
import {
  isDisallowed,
  parseRobotsTxt,
  resolveSitemapUrls,
  type RobotsTxt,
} from "../src/crawl/robots.js";

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
  it("conservatively returns false for an unparseable URL", () => {
    expect(isDisallowed("not a url", robots)).toBe(false);
  });
});

describe("resolveSitemapUrls", () => {
  const origin = "https://example.com";
  const robotsUrl = "https://example.com/robots.txt";
  const allowed = new Set(["https://example.com"]);

  it("falls back to the /sitemap.xml guess when robots.txt is absent", () => {
    expect(resolveSitemapUrls(undefined, origin, robotsUrl, allowed)).toEqual({
      urls: ["https://example.com/sitemap.xml"],
      source: "default",
    });
  });

  it("falls back to the guess when robots.txt declares no sitemap", () => {
    const robots: RobotsTxt = { wildcardDisallows: [], wildcardAllows: [], sitemaps: [] };
    expect(resolveSitemapUrls(robots, origin, robotsUrl, allowed)).toEqual({
      urls: ["https://example.com/sitemap.xml"],
      source: "default",
    });
  });

  it("prefers a declared sitemap over the default guess", () => {
    const robots: RobotsTxt = {
      wildcardDisallows: [],
      wildcardAllows: [],
      sitemaps: ["https://example.com/sitemap-index.xml"],
    };
    expect(resolveSitemapUrls(robots, origin, robotsUrl, allowed)).toEqual({
      urls: ["https://example.com/sitemap-index.xml"],
      source: "robots",
    });
  });

  it("returns every declared sitemap, deduped, in declaration order", () => {
    const robots: RobotsTxt = {
      wildcardDisallows: [],
      wildcardAllows: [],
      sitemaps: [
        "https://example.com/sitemap-products.xml",
        "https://example.com/sitemap-blog.xml",
        "https://example.com/sitemap-products.xml",
      ],
    };
    expect(resolveSitemapUrls(robots, origin, robotsUrl, allowed)).toEqual({
      urls: ["https://example.com/sitemap-products.xml", "https://example.com/sitemap-blog.xml"],
      source: "robots",
    });
  });

  it("resolves a relative Sitemap: line against robots.txt's own URL", () => {
    const robots: RobotsTxt = {
      wildcardDisallows: [],
      wildcardAllows: [],
      sitemaps: ["/sitemap-index.xml"],
    };
    expect(resolveSitemapUrls(robots, origin, robotsUrl, allowed)).toEqual({
      urls: ["https://example.com/sitemap-index.xml"],
      source: "robots",
    });
  });

  it("drops a foreign-origin declared sitemap and falls back to the default guess", () => {
    const robots: RobotsTxt = {
      wildcardDisallows: [],
      wildcardAllows: [],
      sitemaps: ["https://cdn.elsewhere.invalid/sitemap.xml"],
    };
    expect(resolveSitemapUrls(robots, origin, robotsUrl, allowed)).toEqual({
      urls: ["https://example.com/sitemap.xml"],
      source: "default",
    });
  });
});
