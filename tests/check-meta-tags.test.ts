import { describe, expect, it } from "vitest";
import { metaTagsCheck } from "../src/checks/seo/meta-tags.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, ResolvedConfig, Severity } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const goodPage = (
  title: string,
  description = "A perfectly reasonable description that sits comfortably within the limits.",
) => `
  <html lang="en"><head>
    <title>${title}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="https://example.com/">
  </head><body><h1>${title}</h1></body></html>`;

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  environment: Environment = "production",
  checks: ResolvedConfig["checks"] = {},
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
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  logger: { debug: () => undefined },
});

const findingsBySeverity = <T extends { severity: Severity }>(findings: T[], severity: Severity) =>
  findings.filter((finding) => finding.severity === severity);

describe("seo.meta-tags", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("seo.meta-tags");
  });

  it("passes a clean multi-page site with score 100", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        { url: "https://example.com/", body: goodPage("Home") },
        {
          url: "https://example.com/about",
          body: goodPage(
            "About",
            "A different but equally reasonable description within the length limits.",
          ),
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags missing title, description, and lang as errors on the offending page", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        { url: "https://example.com/", body: goodPage("Home") },
        { url: "https://example.com/bad", body: "<html><head></head><body></body></html>" },
      ]),
    );
    const errors = findingsBySeverity(outcome.findings, "error");
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.every((finding) => finding.url === "https://example.com/bad")).toBe(true);
    expect(outcome.score).toBe(50); // 1 of 2 pages clean
    expect(errors.every((finding) => finding.recommendation !== "")).toBe(true);
  });

  it("warns on long titles, out-of-range descriptions, missing canonical, and h1 count", async () => {
    const longTitle = "T".repeat(61);
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: `<html lang="en"><head><title>${longTitle}</title><meta name="description" content="short"></head><body></body></html>`,
        },
      ]),
    );
    const warnings = findingsBySeverity(outcome.findings, "warning");
    expect(warnings.map((finding) => finding.message.toLowerCase()).join(" ")).toContain("60");
    expect(warnings.length).toBeGreaterThanOrEqual(4); // title length, description length, canonical, h1
    expect(outcome.score).toBe(100); // warnings do not reduce the score
  });

  it("flags multiple titles and canonicals as errors and multiple h1s as a warning", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: `<html lang="en"><head>
            <title>First</title>
            <title>Second</title>
            <meta name="description" content="A perfectly reasonable description that sits comfortably within the limits.">
            <link rel="canonical" href="https://example.com/">
            <link rel="canonical" href="https://example.com/other">
          </head><body><h1>One</h1><h1>Two</h1></body></html>`,
        },
      ]),
    );
    const errors = findingsBySeverity(outcome.findings, "error");
    expect(errors).toHaveLength(2);
    expect(errors.some((finding) => finding.message.includes("2 <title>"))).toBe(true);
    expect(errors.some((finding) => finding.message.includes("2 canonical"))).toBe(true);
    const warnings = findingsBySeverity(outcome.findings, "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("2 <h1>");
    expect(outcome.findings.every((finding) => finding.url === "https://example.com/")).toBe(true);
    expect(outcome.score).toBe(0); // the only page has error findings
  });

  it("flags multiple meta description tags on the same page as an error", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: `<html lang="en"><head>
            <title>Home</title>
            <meta name="description" content="A perfectly reasonable description that sits comfortably within the limits.">
            <meta name="description" content="A second description tag that should not be here.">
            <link rel="canonical" href="https://example.com/">
          </head><body><h1>Home</h1></body></html>`,
        },
      ]),
    );
    const errors = findingsBySeverity(outcome.findings, "error");
    expect(errors.some((finding) => finding.message.includes("2 meta description"))).toBe(true);
  });

  it("flags duplicate titles as errors and duplicate descriptions as warnings", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        { url: "https://example.com/", body: goodPage("Same Title") },
        { url: "https://example.com/copy", body: goodPage("Same Title") },
      ]),
    );
    const duplicateTitle = findingsBySeverity(outcome.findings, "error").find((finding) =>
      finding.message.includes("Same Title"),
    );
    expect(duplicateTitle?.url).toBe("https://example.com/copy");
    expect(duplicateTitle?.message).toContain("https://example.com/");
    expect(
      findingsBySeverity(outcome.findings, "warning").some((finding) =>
        finding.message.toLowerCase().includes("description"),
      ),
    ).toBe(true);
  });

  it("treats noindex as an error in production, a warning in ci, and ignores it locally", async () => {
    const noindexPage = {
      url: "https://example.com/",
      body: `<html lang="en"><head><title>Home</title><meta name="description" content="A perfectly reasonable description that sits comfortably within the limits."><link rel="canonical" href="/"><meta name="robots" content="noindex"></head><body><h1>x</h1></body></html>`,
    };
    const production = await metaTagsCheck.run(contextFor([noindexPage], "production"));
    expect(
      findingsBySeverity(production.findings, "error").some((f) => f.message.includes("noindex")),
    ).toBe(true);
    const ci = await metaTagsCheck.run(contextFor([noindexPage], "ci"));
    expect(
      findingsBySeverity(ci.findings, "warning").some((f) => f.message.includes("noindex")),
    ).toBe(true);
    expect(findingsBySeverity(ci.findings, "error")).toEqual([]);
    const local = await metaTagsCheck.run(contextFor([noindexPage], "local"));
    expect(local.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("detects noindex from the X-Robots-Tag header and honors the noindexAllow option", async () => {
    const page = {
      url: "https://example.com/hidden",
      body: goodPage("Hidden"),
      headers: { "content-type": "text/html", "x-robots-tag": "noindex, nofollow" },
    };
    const flagged = await metaTagsCheck.run(contextFor([page], "production"));
    expect(flagged.findings.some((f) => f.message.includes("noindex"))).toBe(true);
    const allowed = await metaTagsCheck.run(
      contextFor([page], "production", {
        "seo.meta-tags": { options: { noindexAllow: ["https://example.com/hidden"] } },
      }),
    );
    expect(allowed.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("normalizes noindexAllow entries so a fragment-carrying config value still matches", async () => {
    const page = {
      url: "https://example.com/hidden",
      body: goodPage("Hidden"),
      headers: { "content-type": "text/html", "x-robots-tag": "noindex, nofollow" },
    };
    const allowed = await metaTagsCheck.run(
      contextFor([page], "production", {
        "seo.meta-tags": { options: { noindexAllow: ["https://example.com/hidden#frag"] } },
      }),
    );
    expect(allowed.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("treats blank titles and descriptions as missing", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: `<html lang="en"><head>
            <title>   </title>
            <meta name="description" content="">
            <link rel="canonical" href="https://example.com/">
          </head><body><h1>Home</h1></body></html>`,
        },
      ]),
    );
    const errors = findingsBySeverity(outcome.findings, "error");
    expect(errors).toHaveLength(2);
    expect(errors.some((finding) => finding.message.toLowerCase().includes("title"))).toBe(true);
    expect(errors.some((finding) => finding.message.toLowerCase().includes("description"))).toBe(
      true,
    );
    expect(outcome.score).toBe(0);
  });

  it("treats X-Robots-Tag: none as noindex, and index/follow as clean", async () => {
    const nonePage = {
      url: "https://example.com/none",
      body: goodPage("None"),
      headers: { "content-type": "text/html", "x-robots-tag": "none" },
    };
    const flagged = await metaTagsCheck.run(contextFor([nonePage], "production"));
    expect(
      findingsBySeverity(flagged.findings, "error").some((f) => f.message.includes("noindex")),
    ).toBe(true);

    const okPage = {
      url: "https://example.com/ok",
      body: goodPage("Ok"),
      headers: { "content-type": "text/html", "x-robots-tag": "index, follow" },
    };
    const clean = await metaTagsCheck.run(contextFor([okPage], "production"));
    expect(clean.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("detects UA-prefixed X-Robots-Tag noindex and ignores unavailable_after dates", async () => {
    const prefixedPage = {
      url: "https://example.com/prefixed",
      body: goodPage("Prefixed"),
      headers: { "content-type": "text/html", "x-robots-tag": "googlebot: noindex, nofollow" },
    };
    const flagged = await metaTagsCheck.run(contextFor([prefixedPage], "production"));
    expect(
      findingsBySeverity(flagged.findings, "error").some((f) => f.message.includes("noindex")),
    ).toBe(true);

    const datedPage = {
      url: "https://example.com/dated",
      body: goodPage("Dated"),
      headers: { "content-type": "text/html", "x-robots-tag": "unavailable_after: 2027-01-01" },
    };
    const clean = await metaTagsCheck.run(contextFor([datedPage], "production"));
    expect(clean.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("only evaluates 2xx HTML pages and returns 100 for an empty store", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/gone",
          body: "<html><head></head></html>",
          status: 404,
          ok: false,
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
