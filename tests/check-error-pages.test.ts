import { afterEach, describe, expect, it } from "vitest";
import { errorPagesCheck } from "../src/checks/functionality/error-pages.js";
import { builtinChecks } from "../src/engine/registry.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import type { CheckContext, CheckOverride, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const configWith = (checks: Record<string, CheckOverride> = {}): ResolvedConfig => ({
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks,
  customChecks: [],
});

const contextFor = (baseUrl: string, checks: Record<string, CheckOverride> = {}): CheckContext => ({
  baseUrl,
  environment: "local",
  config: configWith(checks),
  pages: fixturePageStore(),
  fetch: createFetcher(),
  logger: { debug: () => undefined },
});

describe("functionality.error-pages", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((c) => c.id)).toContain("functionality.error-pages");
  });

  it("passes with score 100 when unknown paths return a real 404", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("<html><body>not found</body></html>");
    });
    const outcome = await errorPagesCheck.run(contextFor(server.url));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags a soft 404 when unknown paths return 200", async () => {
    server = await startServer((_req, res) => {
      res.end("<html><body>everything is fine</body></html>");
    });
    const outcome = await errorPagesCheck.run(contextFor(server.url));
    expect(outcome.score).toBe(80);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("error");
    expect(outcome.findings[0]?.message).toContain("soft 404");
  });

  it("warns when unknown paths redirect instead of 404ing", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302, { Location: "https://elsewhere.invalid/" });
      res.end();
    });
    const outcome = await errorPagesCheck.run(contextFor(server.url));
    expect(outcome.score).toBe(95);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("302");
  });

  it("warns (not errors) when unknown paths redirect same-origin to the homepage", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/") {
        res.end("<html><body>home</body></html>");
        return;
      }
      res.writeHead(302, { Location: "/" });
      res.end();
    });
    const outcome = await errorPagesCheck.run(contextFor(server.url));
    expect(outcome.score).toBe(95);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("redirect");
  });

  it("passes when the 404 body contains the configured marker", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("<html><body>Sorry, page-not-found-marker here</body></html>");
    });
    const outcome = await errorPagesCheck.run(
      contextFor(server.url, {
        "functionality.error-pages": { options: { notFoundMarker: "page-not-found-marker" } },
      }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns when the 404 body lacks the configured marker", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("<html><body>generic 404</body></html>");
    });
    const outcome = await errorPagesCheck.run(
      contextFor(server.url, {
        "functionality.error-pages": { options: { notFoundMarker: "page-not-found-marker" } },
      }),
    );
    expect(outcome.score).toBe(95);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("page-not-found-marker");
  });

  it("warns with score 95 when the base is unreachable", async () => {
    const outcome = await errorPagesCheck.run({
      ...contextFor("http://127.0.0.1:1"),
      baseUrl: "http://127.0.0.1:1",
      fetch: createFetcher({ timeoutMs: 300 }),
    });
    expect(outcome.score).toBe(95);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("Could not verify");
  });

  it("ignores the page store — an empty store is fine", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await errorPagesCheck.run({
      ...contextFor(server.url),
      pages: fixturePageStore([]),
    });
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
