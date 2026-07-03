import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/crawl/extract-links.js";

describe("extractLinks", () => {
  it("extracts, resolves, normalizes, and dedupes anchor hrefs", () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="/about#team">Team</a>
      <a href="contact.html">Contact</a>
      <a href="https://other.example/page">External</a>
      <a href="mailto:a@b.c">Mail</a>
      <a href="javascript:void(0)">JS</a>
      <a>no href</a>
    </body></html>`;
    expect(extractLinks(html, "https://example.com/dir/index.html").sort()).toEqual([
      "https://example.com/about",
      "https://example.com/dir/contact.html",
      "https://other.example/page",
    ]);
  });

  it("returns an empty array for HTML without links and for junk input", () => {
    expect(extractLinks("<p>plain</p>", "https://example.com/")).toEqual([]);
    expect(extractLinks("%%%not-html%%%", "https://example.com/")).toEqual([]);
  });
});
