import { describe, expect, it } from "vitest";
import { extractPageMeta } from "../src/checks/seo/page-meta.js";

describe("extractPageMeta", () => {
  it("extracts title, description, canonical, h1 count, and lang", () => {
    const meta = extractPageMeta(`<!doctype html>
      <html lang="en"><head>
        <title>  Home  </title>
        <meta name="description" content=" Welcome to our site, the best site on the internet for sites. ">
        <link rel="canonical" href="https://example.com/">
      </head><body><h1>Hi</h1><h1>Second</h1></body></html>`);
    expect(meta).toEqual({
      titles: ["Home"],
      descriptions: ["Welcome to our site, the best site on the internet for sites."],
      canonicals: ["https://example.com/"],
      h1Count: 2,
      lang: "en",
      metaNoindex: false,
    });
  });

  it("reports missing elements as empty/undefined", () => {
    const meta = extractPageMeta("<html><head></head><body><p>bare</p></body></html>");
    expect(meta).toEqual({
      titles: [],
      descriptions: [],
      canonicals: [],
      h1Count: 0,
      lang: undefined,
      metaNoindex: false,
    });
  });

  it("collects duplicate titles and matches attributes case-insensitively", () => {
    const meta = extractPageMeta(`<html lang="en"><head>
      <title>One</title><title>Two</title>
      <META NAME="Description" CONTENT="desc">
      <link REL="Canonical" href="/x">
    </head><body></body></html>`);
    expect(meta.titles).toEqual(["One", "Two"]);
    expect(meta.descriptions).toEqual(["desc"]);
    expect(meta.canonicals).toEqual(["/x"]);
  });

  it("detects noindex and none in robots meta, case-insensitively", () => {
    const noindex = extractPageMeta(
      `<html><head><meta name="robots" content="NOINDEX, follow"></head><body></body></html>`,
    );
    expect(noindex.metaNoindex).toBe(true);
    const none = extractPageMeta(
      `<html><head><meta name="robots" content="none"></head><body></body></html>`,
    );
    expect(none.metaNoindex).toBe(true);
    const indexable = extractPageMeta(
      `<html><head><meta name="robots" content="index, nofollow"></head><body></body></html>`,
    );
    expect(indexable.metaNoindex).toBe(false);
  });

  it("treats an empty lang attribute as missing", () => {
    expect(extractPageMeta(`<html lang=""><head></head></html>`).lang).toBeUndefined();
  });
});
