import { describe, expect, it } from "vitest";
import { samplePages } from "../src/browser/sample.js";
import { fixturePage } from "./helpers/page-store.js";

const page = (url: string, extra = {}) => fixturePage({ url, ...extra });

describe("samplePages", () => {
  it("puts the base page first, then up to size more in order", () => {
    const pages = [page("https://x.com/a"), page("https://x.com/"), page("https://x.com/b")];
    const sampled = samplePages(pages, "https://x.com/", 1);
    expect(sampled.map((p) => new URL(p.url).pathname)).toEqual(["/", "/a"]);
  });

  it("size 0 yields only the base page", () => {
    const pages = [page("https://x.com/"), page("https://x.com/a")];
    expect(samplePages(pages, "https://x.com/", 0).map((p) => p.url)).toEqual(["https://x.com/"]);
  });

  it("excludes non-2xx and non-HTML pages", () => {
    const pages = [
      page("https://x.com/"),
      page("https://x.com/gone", { status: 404, ok: false }),
      page("https://x.com/data.json", { headers: { "content-type": "application/json" } }),
      page("https://x.com/ok"),
    ];
    expect(samplePages(pages, "https://x.com/", 10).map((p) => new URL(p.url).pathname)).toEqual([
      "/",
      "/ok",
    ]);
  });

  it("still returns extras when the base URL was not crawled", () => {
    const pages = [page("https://x.com/a"), page("https://x.com/b")];
    expect(samplePages(pages, "https://x.com/", 1).map((p) => new URL(p.url).pathname)).toEqual([
      "/a",
    ]);
  });
});
