import { describe, expect, it } from "vitest";
import { extractPageMeta } from "../src/checks/seo/page-meta.js";
import { extractVisibleText, placeholdersCheck } from "../src/checks/content/placeholders.js";
import { pageDom } from "../src/crawl/page-dom.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const html = (body: string, head = "<title>t</title>") =>
  `<html lang="en"><head>${head}</head><body>${body}</body></html>`;

const fetchStub = (): Promise<FetchResult> => Promise.reject(new Error("not used"));

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  checks: ResolvedConfig["checks"] = {},
  environment: Environment = "ci",
): CheckContext => ({
  baseUrl: "https://example.com",
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    requestHeaders: {},
    checks,
    customChecks: [],
  },
  pages: fixturePageStore(pages),
  fetch: fetchStub,
  logger: { debug: () => undefined },
});

describe("content.placeholders", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("content.placeholders");
  });

  it("returns a clean result for a page with no placeholders", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor([{ url: "https://example.com/", body: html("<p>Welcome to our site.</p>") }]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags lorem ipsum with an excerpt and dirties the page score", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor([
        { url: "https://example.com/", body: html("<p>Lorem Ipsum dolor sit amet.</p>") },
      ]),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('"lorem ipsum"');
    expect(errors[0]?.message).toContain("Lorem Ipsum dolor sit amet");
    expect(outcome.score).toBe(0);
  });

  it("flags an unrendered template marker literally left in the page", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor([{ url: "https://example.com/", body: html("<p>{{title}}</p>") }]),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors.some((finding) => finding.message.includes("unrendered template"))).toBe(true);
  });

  it("flags standalone 'undefined' but ignores it inside a longer word or different case", async () => {
    const dirty = await placeholdersCheck.run(
      contextFor([{ url: "https://example.com/", body: html("<p>Price: undefined</p>") }]),
    );
    expect(dirty.findings.filter((finding) => finding.severity === "error")).toHaveLength(1);

    const clean = await placeholdersCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: html("<p>undefinedBehavior is a technical term. Undefined is capitalized.</p>"),
        },
      ]),
    );
    expect(clean).toEqual({ score: 100, findings: [] });
  });

  it("flags TODO as a warning without dirtying the score", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor([{ url: "https://example.com/", body: html("<p>TODO: write copy</p>") }]),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.score).toBe(100);
  });

  it("ignores markers inside script/style bodies since only visible text is scanned", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: html(
            "<p>All good.</p><script>var x = undefined; // TODO fixme</script><style>.a { content: 'lorem ipsum'; }</style>",
          ),
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("does not mutate the shared pageDom cache", async () => {
    const [page] = fixturePageStore([
      {
        url: "https://example.com/",
        body: html("<p>All good.</p><script>var x = 1;</script>", "<title>Real Title</title>"),
      },
    ]).all();
    if (page === undefined) throw new Error("expected a page");

    await placeholdersCheck.run(contextFor([page]));

    expect(pageDom(page)("script")).toHaveLength(1);
    expect(extractPageMeta(pageDom(page)).titles).toEqual(["Real Title"]);
  });

  it("supports custom patterns option, matched case-insensitively", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html("<p>Welcome, insert client name!</p>") }],
        { "content.placeholders": { options: { patterns: ["INSERT CLIENT NAME"] } } },
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("INSERT CLIENT NAME");
  });

  it("skips pages matching the ignore option entirely", async () => {
    const outcome = await placeholdersCheck.run(
      contextFor(
        [{ url: "https://example.com/staging-preview", body: html("<p>Lorem Ipsum</p>") }],
        { "content.placeholders": { options: { ignore: ["staging-preview"] } } },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("returns a clean result for an empty page store", async () => {
    const outcome = await placeholdersCheck.run(contextFor([]));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});

describe("extractVisibleText", () => {
  it("collapses whitespace and excludes script/style/noscript/template content", () => {
    const $ = pageDom({
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      status: 200,
      ok: true,
      headers: { "content-type": "text/html" },
      body: html(
        "<p>Hello   world.</p><script>ignored()</script><style>.a{}</style><noscript>no js</noscript><template><span>tpl</span></template>",
      ),
      redirected: false,
      durationMs: 1,
    });
    expect(extractVisibleText($)).toBe("Hello world.");
  });
});
