import { describe, expect, it } from "vitest";
import { extractPageRefs, hasAnchorTarget } from "../src/checks/functionality/link-extract.js";
import { allowedOriginsFor } from "../src/crawl/crawler.js";

describe("extractPageRefs", () => {
  it("extracts links with fragments preserved and resolved against the page", () => {
    const { links } = extractPageRefs(
      `<a href="/about#team">t</a><a href="/about">a</a><a href="https://ext.example/x">e</a>
       <a href="mailto:a@b.c">m</a><a href="#local">l</a>`,
      "https://example.com/dir/page",
    );
    expect(links).toEqual([
      { url: "https://example.com/about", fragment: "team" },
      { url: "https://example.com/about", fragment: undefined },
      { url: "https://ext.example/x", fragment: undefined },
      { url: "https://example.com/dir/page", fragment: "local" },
    ]);
  });

  it("dedupes identical url+fragment pairs and decodes encoded fragments", () => {
    const { links } = extractPageRefs(
      `<a href="/a#s%C3%A9ction">1</a><a href="/a#s%C3%A9ction">2</a>`,
      "https://example.com/",
    );
    expect(links).toEqual([{ url: "https://example.com/a", fragment: "séction" }]);
  });

  it("keeps a fragmentless link distinct from one whose fragment decodes to the sentinel", () => {
    const { links } = extractPageRefs(
      `<a href="/a">1</a><a href="/a#%EF%BF%BD">2</a>`,
      "https://example.com/",
    );
    expect(links).toEqual([
      { url: "https://example.com/a", fragment: undefined },
      { url: "https://example.com/a", fragment: "�" },
    ]);
  });

  it("collects assets from img src/srcset, source, script, stylesheet, video and audio", () => {
    const { assets } = extractPageRefs(
      `<img src="/i.png">
       <img srcset="/i-1x.png 1x, /i-2x.png 2x">
       <source srcset="/s.webp 100w" src="/s.mp4">
       <script src="/app.js"></script>
       <link rel="stylesheet" href="/main.css">
       <link rel="icon" href="/favicon.ico">
       <video src="/v.mp4"></video><audio src="/a.mp3"></audio>
       <img src="data:image/png;base64,AAAA">`,
      "https://example.com/",
    );
    expect(assets.sort()).toEqual([
      "https://example.com/a.mp3",
      "https://example.com/app.js",
      "https://example.com/i-1x.png",
      "https://example.com/i-2x.png",
      "https://example.com/i.png",
      "https://example.com/main.css",
      "https://example.com/s.mp4",
      "https://example.com/s.webp",
      "https://example.com/v.mp4",
    ]);
  });
});

describe("hasAnchorTarget", () => {
  const html = `<div id="team"></div><a name="legacy"></a><section id="a&quot;b"></section>`;
  it("finds element ids and legacy a[name] anchors", () => {
    expect(hasAnchorTarget(html, "team")).toBe(true);
    expect(hasAnchorTarget(html, "legacy")).toBe(true);
    expect(hasAnchorTarget(html, "missing")).toBe(false);
  });
  it("always accepts empty and top fragments", () => {
    expect(hasAnchorTarget(html, "")).toBe(true);
    expect(hasAnchorTarget(html, "top")).toBe(true);
  });
  it("matches ids containing quotes without selector injection", () => {
    expect(hasAnchorTarget(html, 'a"b')).toBe(true);
  });
});

describe("allowedOriginsFor (exported)", () => {
  it("returns the base origin plus its https twin for http bases", () => {
    expect(allowedOriginsFor(new URL("http://example.com/"))).toEqual(
      new Set(["http://example.com", "https://example.com"]),
    );
    expect(allowedOriginsFor(new URL("https://example.com/"))).toEqual(
      new Set(["https://example.com"]),
    );
  });
});
