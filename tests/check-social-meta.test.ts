import { describe, expect, it } from "vitest";
import { socialMetaCheck } from "../src/checks/seo/social-meta.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const html = (head: string) =>
  `<html lang="en"><head><title>t</title>${head}</head><body>content</body></html>`;

type FetchStub = (url: string, init?: { method?: string }) => Promise<FetchResult>;

const stubResult = (url: string, status: number, contentType = ""): FetchResult => ({
  url,
  status,
  ok: status >= 200 && status < 300,
  headers: contentType === "" ? {} : { "content-type": contentType },
  body: "",
  redirected: false,
  durationMs: 1,
});

const fetchStub =
  (routes: Record<string, number | "reject" | [number, string]>, log: string[] = []): FetchStub =>
  (url, init) => {
    const method = init?.method ?? "GET";
    log.push(`${method} ${url}`);
    const route = routes[`${method} ${url}`] ?? routes[url];
    if (route === undefined) return Promise.resolve(stubResult(url, 404));
    if (route === "reject") return Promise.reject(new Error("connection refused"));
    if (Array.isArray(route)) return Promise.resolve(stubResult(url, route[0], route[1]));
    return Promise.resolve(stubResult(url, route));
  };

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  fetch: FetchStub = fetchStub({}),
  environment: Environment = "ci",
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
  fetch,
  logger: { debug: () => undefined },
});

const fullOgHead = (imageUrl = "https://example.com/img/share.png") => `
  <meta property="og:title" content="Title">
  <meta property="og:description" content="Description">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:url" content="https://example.com/">
  <meta name="twitter:card" content="summary_large_image">
`;

describe("seo.social-meta", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("seo.social-meta");
  });

  it("passes a page with complete OG set, twitter:card, and a resolving same-origin og:image", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead()) }],
        fetchStub({ "https://example.com/img/share.png": [200, "image/png"] }),
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns exactly once for a page with zero OG tags", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor([{ url: "https://example.com/", body: html("") }]),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("no Open Graph tags");
    expect(outcome.score).toBe(100);
  });

  it("warns on each missing OG field and flags missing twitter:card as info, for a page with og:title only", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor([
        { url: "https://example.com/", body: html('<meta property="og:title" content="Title">') },
      ]),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    const infos = outcome.findings.filter((finding) => finding.severity === "info");
    expect(warnings).toHaveLength(3);
    expect(warnings.map((finding) => finding.message).join(" ")).toContain("og:description");
    expect(warnings.map((finding) => finding.message).join(" ")).toContain("og:image");
    expect(warnings.map((finding) => finding.message).join(" ")).toContain("og:url");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain("twitter:card");
    expect(outcome.score).toBe(100);
  });

  it("warns on a relative og:image without probing it", async () => {
    const log: string[] = [];
    const outcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead("/img/share.png")) }],
        fetchStub({}, log),
      ),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("not an absolute URL");
    expect(log).toHaveLength(0);
  });

  it("warns on a malformed og:image (bare scheme) instead of crashing", async () => {
    const log: string[] = [];
    const outcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead("https://")) }],
        fetchStub({}, log),
      ),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("not an absolute URL");
    expect(outcome.score).toBe(100);
    expect(log).toHaveLength(0);
  });

  it("errors on a same-origin og:image that 404s and dirties the page score", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead()) }],
        fetchStub({ "https://example.com/img/share.png": 404 }),
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("does not resolve");
    expect(errors[0]?.url).toBe("https://example.com/");
    expect(outcome.score).toBe(0);
  });

  it("probes a shared broken og:image once and attributes the single error to the first referencing page", async () => {
    const log: string[] = [];
    const outcome = await socialMetaCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: html(fullOgHead()) },
          { url: "https://example.com/two", body: html(fullOgHead()) },
        ],
        fetchStub({ "https://example.com/img/share.png": 404 }, log),
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.url).toBe("https://example.com/");
    expect(log.filter((entry) => entry.includes("/img/share.png"))).toHaveLength(1); // probed once despite two referencing pages
  });

  it("does not probe a broken cross-origin og:image in ci, but probes and warns in production", async () => {
    const log: string[] = [];
    const ciOutcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead("https://ext.example/share.png")) }],
        fetchStub({}, log),
        "ci",
      ),
    );
    expect(log).toHaveLength(0);
    expect(ciOutcome.score).toBe(100);
    expect(ciOutcome.findings).toHaveLength(0);

    const prodOutcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead("https://ext.example/share.png")) }],
        fetchStub({ "https://ext.example/share.png": 404 }),
        "production",
      ),
    );
    const warnings = prodOutcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("does not resolve");
    expect(prodOutcome.score).toBe(100);
  });

  it("warns when a resolving og:image is not actually an image", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html(fullOgHead()) }],
        fetchStub({ "https://example.com/img/share.png": [200, "text/html"] }),
      ),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("not an image");
  });

  it("returns a clean result for an empty page store", async () => {
    const outcome = await socialMetaCheck.run(contextFor([]));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("detects og:image via og:image:url fallback when og:image is missing", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html(`
              <meta property="og:title" content="Title">
              <meta property="og:description" content="Description">
              <meta property="og:image:url" content="https://example.com/img/share.png">
              <meta property="og:url" content="https://example.com/">
              <meta name="twitter:card" content="summary_large_image">
            `),
          },
        ],
        fetchStub({ "https://example.com/img/share.png": [200, "image/png"] }),
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("detects twitter:card via property form when name form is missing", async () => {
    const outcome = await socialMetaCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html(`
            <meta property="og:title" content="Title">
            <meta property="og:description" content="Description">
            <meta property="og:image" content="https://example.com/img/share.png">
            <meta property="og:url" content="https://example.com/">
            <meta property="twitter:card" content="summary_large_image">
          `),
          },
        ],
        fetchStub({ "https://example.com/img/share.png": [200, "image/png"] }),
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
