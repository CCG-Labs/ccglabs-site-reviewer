import { describe, expect, it } from "vitest";
import { pageDom } from "../src/crawl/page-dom.js";
import { extractPageMeta } from "../src/checks/seo/page-meta.js";
import { fixturePage } from "./helpers/page-store.js";

describe("pageDom", () => {
  it("returns the same parsed handle for repeated calls on one page", () => {
    const page = fixturePage({
      url: "https://example.com/",
      body: "<html><head><title>T</title></head></html>",
    });
    const first = pageDom(page);
    expect(pageDom(page)).toBe(first);
  });

  it("parses distinct pages independently", () => {
    const a = fixturePage({
      url: "https://example.com/a",
      body: "<html><head><title>A</title></head></html>",
    });
    const b = fixturePage({
      url: "https://example.com/b",
      body: "<html><head><title>B</title></head></html>",
    });
    expect(pageDom(a)("title").text()).toBe("A");
    expect(pageDom(b)("title").text()).toBe("B");
  });

  it("extractors accept a pre-parsed handle and agree with string input", () => {
    const html = '<html lang="en"><head><title>T</title></head><body></body></html>';
    const page = fixturePage({ url: "https://example.com/", body: html });
    expect(extractPageMeta(pageDom(page))).toEqual(extractPageMeta(html));
  });
});
