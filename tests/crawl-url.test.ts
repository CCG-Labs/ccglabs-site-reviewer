import { describe, expect, it } from "vitest";
import { normalizePageUrl } from "../src/crawl/url.js";

describe("normalizePageUrl", () => {
  it("resolves relative URLs against a base", () => {
    expect(normalizePageUrl("/about", "https://example.com/index.html")).toBe(
      "https://example.com/about",
    );
  });

  it("strips fragments but keeps query strings", () => {
    expect(normalizePageUrl("https://example.com/a?q=1#section")).toBe("https://example.com/a?q=1");
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizePageUrl("mailto:a@b.c")).toBeUndefined();
    expect(normalizePageUrl("javascript:void(0)", "https://example.com/")).toBeUndefined();
    expect(normalizePageUrl("tel:+15555555555", "https://example.com/")).toBeUndefined();
  });

  it("returns undefined for unparseable input", () => {
    expect(normalizePageUrl("http://")).toBeUndefined();
    expect(normalizePageUrl("not a url")).toBeUndefined();
  });
});
