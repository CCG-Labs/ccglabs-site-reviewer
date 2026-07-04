import { describe, expect, it } from "vitest";
import { linksCheck } from "../src/checks/functionality/links.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const html = (body: string) =>
  `<html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

type FetchStub = (url: string, init?: { method?: string }) => Promise<FetchResult>;

const stubResult = (url: string, status: number): FetchResult => ({
  url,
  status,
  ok: status >= 200 && status < 300,
  headers: {},
  body: "",
  redirected: false,
  durationMs: 1,
});

const fetchStub =
  (routes: Record<string, number | "reject">, log: string[] = []): FetchStub =>
  (url, init) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[url];
    if (route === undefined) return Promise.resolve(stubResult(url, 404));
    if (route === "reject") return Promise.reject(new Error("connection refused"));
    return Promise.resolve(stubResult(url, route));
  };

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  fetch: FetchStub = fetchStub({}),
  environment: Environment = "ci",
  checks: ResolvedConfig["checks"] = {},
  stats: Parameters<typeof fixturePageStore>[1] = {},
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
  pages: fixturePageStore(pages, stats),
  fetch,
  logger: { debug: () => undefined },
});

describe("functionality.links", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("functionality.links");
  });

  it("passes a site whose internal links and anchors all resolve", async () => {
    const outcome = await linksCheck.run(
      contextFor([
        { url: "https://example.com/", body: html('<a href="/about#team">a</a>') },
        {
          url: "https://example.com/about",
          body: html('<div id="team"></div><a href="/">home</a>'),
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags links to 404 pages and to unfetchable pages as errors on the linking page", async () => {
    const outcome = await linksCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: html('<a href="/gone">g</a><a href="/never-crawled">n</a>'),
        },
        { url: "https://example.com/gone", status: 404, ok: false, body: html("nope") },
      ]),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(2);
    expect(errors.every((finding) => finding.url === "https://example.com/")).toBe(true);
    expect(errors.map((finding) => finding.message).join(" ")).toContain("404");
    expect(outcome.score).toBe(0); // /gone is non-2xx so pages checked = [/] only; that one page carries errors
  });

  it("skips unverifiable links instead of guessing when the crawl was capped", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="/uncrawled">u</a>') }],
        fetchStub({}),
        "ci",
        {},
        { capped: true },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns on missing anchor targets without failing the run", async () => {
    const outcome = await linksCheck.run(
      contextFor([
        { url: "https://example.com/", body: html('<a href="/about#nope">a</a>') },
        { url: "https://example.com/about", body: html('<div id="team"></div>') },
      ]),
    );
    expect(outcome.score).toBe(100);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("#nope");
  });

  it("probes internal assets with HEAD, falls back to GET on 405, and errors on broken ones", async () => {
    const log: string[] = [];
    const outcome = await linksCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html(
              '<img src="/ok.png"><img src="/missing.png"><script src="/fussy.js"></script>',
            ),
          },
        ],
        fetchStub(
          {
            "https://example.com/ok.png": 200,
            "https://example.com/missing.png": 404,
            "https://example.com/fussy.js": 405,
          },
          log,
        ),
      ),
    );
    // 405 → GET fallback; the stub returns 405 again, which counts as broken (>=400)
    expect(log).toContain("HEAD https://example.com/ok.png");
    expect(log).toContain("GET https://example.com/fussy.js");
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => finding.message).join(" ")).toContain("/missing.png");
    expect(outcome.score).toBe(0);
  });

  it("probes each unique URL once across pages", async () => {
    const log: string[] = [];
    await linksCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: html('<img src="/shared.png">') },
          { url: "https://example.com/two", body: html('<img src="/shared.png">') },
        ],
        fetchStub({ "https://example.com/shared.png": 200 }, log),
      ),
    );
    expect(log.filter((entry) => entry.includes("/shared.png"))).toHaveLength(1);
  });

  it("honors the ignore option for links and assets", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="/gone">g</a><img src="/dead.png">') }],
        fetchStub({}),
        "ci",
        { "functionality.links": { options: { ignore: ["/gone", "/dead.png"] } } },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("probes external URLs in production and passes when they resolve", async () => {
    const log: string[] = [];
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="https://ext.example/ok">e</a>') }],
        fetchStub({ "https://ext.example/ok": 200 }, log),
        "production",
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(log).toContain("HEAD https://ext.example/ok");
  });

  it("does not probe external URLs outside production", async () => {
    const log: string[] = [];
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="https://ext.example/dead">e</a>') }],
        fetchStub({}, log),
        "ci",
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(log).toHaveLength(0);
  });

  it("warns on broken external links in production, attributed to the referencing page", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html(
              '<a href="https://ext.example/dead">e</a><a href="https://ext.example/alive">a</a>',
            ),
          },
        ],
        fetchStub({ "https://ext.example/dead": 404, "https://ext.example/alive": 200 }),
        "production",
      ),
    );
    expect(outcome.score).toBe(100); // warnings never reduce score
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("https://ext.example/dead");
    expect(outcome.findings[0]?.url).toBe("https://example.com/");
  });

  it("treats external 403/429 as bot protection, not breakage", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="https://ext.example/waf">w</a>') }],
        fetchStub({ "https://ext.example/waf": 403 }),
        "production",
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("caps external probing at 50 unique URLs", async () => {
    const log: string[] = [];
    const body = html(
      Array.from(
        { length: 60 },
        (_v, i) => `<a href="https://ext.example/p${String(i)}">x</a>`,
      ).join(""),
    );
    const routes: Record<string, number> = {};
    for (let i = 0; i < 60; i += 1) routes[`https://ext.example/p${String(i)}`] = 200;
    await linksCheck.run(
      contextFor([{ url: "https://example.com/", body }], fetchStub(routes, log), "production"),
    );
    expect(log).toHaveLength(50);
  });

  it("warns when an external link is unreachable in production", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="https://ext.example/down">d</a>') }],
        fetchStub({ "https://ext.example/down": "reject" }),
        "production",
      ),
    );
    expect(outcome.score).toBe(100);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("unreachable");
  });
});
