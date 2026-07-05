import { describe, expect, it } from "vitest";
import { imagesCheck } from "../src/checks/content/images.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const html = (body: string) =>
  `<html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

type FetchStub = (url: string, init?: { method?: string }) => Promise<FetchResult>;

const stubResult = (
  url: string,
  status: number,
  headers: Record<string, string> = {},
): FetchResult => ({
  url,
  status,
  ok: status >= 200 && status < 300,
  headers,
  body: "",
  redirected: false,
  durationMs: 1,
});

const fetchStub =
  (
    routes: Record<string, number | "reject" | [number, Record<string, string>]>,
    log: string[] = [],
  ): FetchStub =>
  (url, init) => {
    const method = init?.method ?? "GET";
    log.push(`${method} ${url}`);
    const route = routes[`${method} ${url}`] ?? routes[url];
    if (route === undefined) return Promise.resolve(stubResult(url, 404));
    if (route === "reject") return Promise.reject(new Error("connection refused"));
    if (Array.isArray(route)) return Promise.resolve(stubResult(url, route[0], route[1]));
    return Promise.resolve(stubResult(url, route));
  };

const contentLength = (bytes: number): [number, Record<string, string>] => [
  200,
  { "content-length": String(bytes) },
];

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
    browserSampleSize: 5,
    requestHeaders: {},
    checks,
    customChecks: [],
  },
  pages: fixturePageStore(pages),
  fetch,
  logger: { debug: () => undefined },
});

describe("content.images", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("content.images");
  });

  it("passes a page with a fully-specified, appropriately-sized image", async () => {
    const outcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/a.png" alt="A" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/a.png": contentLength(1000) }),
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it('errors in production on an image with no alt attribute, listing its src; alt="" is clean', async () => {
    const dirty = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/a.png" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/a.png": contentLength(1000) }),
        "production",
      ),
    );
    const errors = dirty.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("missing an alt attribute");
    expect(errors[0]?.message).toContain("/a.png");
    expect(dirty.score).toBe(0);

    const clean = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/a.png" alt="" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/a.png": contentLength(1000) }),
        "production",
      ),
    );
    expect(clean).toEqual({ score: 100, findings: [] });
  });

  it("softens a missing-alt finding to a warning outside production, keeping score clean", async () => {
    const outcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/a.png" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/a.png": contentLength(1000) }),
        "ci",
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("missing an alt attribute");
    expect(warnings[0]?.recommendation).toContain("(reported as a warning outside production.)");
    expect(outcome.score).toBe(100);
  });

  it("warns (aggregated) on an image missing both width and height; width-only is clean", async () => {
    const dirty = await imagesCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<img src="/a.png" alt="A">') }],
        fetchStub({ "https://example.com/a.png": contentLength(1000) }),
      ),
    );
    const warnings = dirty.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("without width/height attributes");
    expect(warnings[0]?.message).toContain("/a.png");
    expect(dirty.score).toBe(100);

    const clean = await imagesCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<img src="/a.png" alt="A" width="10">') }],
        fetchStub({ "https://example.com/a.png": contentLength(1000) }),
      ),
    );
    expect(clean).toEqual({ score: 100, findings: [] });
  });

  it("warns on an oversized same-origin image naming the KB size; a raised maxImageBytes clears it", async () => {
    const oversized = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/big.png" alt="Big" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/big.png": contentLength(600_000) }),
      ),
    );
    const warnings = oversized.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("Oversized image");
    expect(warnings[0]?.message).toContain("586 KB");

    const clean = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/big.png" alt="Big" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/big.png": contentLength(600_000) }),
        "ci",
        { "content.images": { options: { maxImageBytes: 1_000_000 } } },
      ),
    );
    expect(clean).toEqual({ score: 100, findings: [] });
  });

  it("skips the size check when the content-length header is missing", async () => {
    const outcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/a.png" alt="A" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/a.png": 200 }),
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("probes the same image referenced by two pages only once", async () => {
    const log: string[] = [];
    await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/shared.png" alt="A" width="10" height="10">'),
          },
          {
            url: "https://example.com/two",
            body: html('<img src="/shared.png" alt="A" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://example.com/shared.png": contentLength(1000) }, log),
      ),
    );
    expect(log.filter((entry) => entry.includes("/shared.png"))).toHaveLength(1);
  });

  it("does not probe a cross-origin image in ci, but does in production", async () => {
    const log: string[] = [];
    const ciOutcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="https://ext.example/pic.png" alt="A" width="10" height="10">'),
          },
        ],
        fetchStub({}, log),
        "ci",
      ),
    );
    expect(log).toHaveLength(0);
    expect(ciOutcome).toEqual({ score: 100, findings: [] });

    const prodLog: string[] = [];
    const prodOutcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="https://ext.example/pic.png" alt="A" width="10" height="10">'),
          },
        ],
        fetchStub({ "https://ext.example/pic.png": contentLength(600_000) }, prodLog),
        "production",
      ),
    );
    expect(prodLog.filter((entry) => entry.includes("/pic.png"))).toHaveLength(1);
    const warnings = prodOutcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("Oversized image");
  });

  it("suppresses both the alt finding and the probe for srcs matching the ignore option", async () => {
    const log: string[] = [];
    const outcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html('<img src="/tracking-pixel.gif">'),
          },
        ],
        fetchStub({}, log),
        "ci",
        { "content.images": { options: { ignore: ["tracking-pixel"] } } },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(log).toHaveLength(0);
  });

  it("returns a clean result for an empty page store", async () => {
    const outcome = await imagesCheck.run(contextFor([]));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("truncates a long data: URI src in finding messages", async () => {
    const longDataUri = `data:image/png;base64,${"A".repeat(5000)}`;
    const outcome = await imagesCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html(`<img src="${longDataUri}">`),
          },
        ],
        fetchStub({}),
        "production",
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message.length).toBeLessThan(200);
    expect(errors[0]?.message).toContain("…");
    expect(errors[0]?.message).not.toContain(longDataUri);
  });
});
