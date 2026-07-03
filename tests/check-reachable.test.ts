import { afterEach, describe, expect, it } from "vitest";
import { reachableCheck } from "../src/checks/functionality/reachable.js";
import { builtinChecks } from "../src/engine/registry.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const config: ResolvedConfig = {
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks: {},
  customChecks: [],
};

const contextFor = (baseUrl: string): CheckContext => ({
  baseUrl,
  environment: "local",
  config,
  fetch: createFetcher(),
  logger: { debug: () => undefined },
});

describe("functionality.reachable", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((c) => c.id)).toContain("functionality.reachable");
  });

  it("passes with score 100 when the base URL returns 200", async () => {
    server = await startServer((_req, res) => {
      res.end("<html></html>");
    });
    const outcome = await reachableCheck.run(contextFor(server.url));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("fails with a recommendation when the base URL returns a 4xx/5xx", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const outcome = await reachableCheck.run(contextFor(server.url));
    expect(outcome.score).toBe(0);
    expect(outcome.findings[0]?.severity).toBe("error");
    expect(outcome.findings[0]?.message).toContain("503");
    expect(outcome.findings[0]?.recommendation).not.toBe("");
  });
});
