import { describe, expect, it } from "vitest";
import { crawlCoverageCheck } from "../src/checks/functionality/crawl-coverage.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const config: ResolvedConfig = {
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks: {},
  customChecks: [],
};

const contextWith = (pages: CheckContext["pages"]): CheckContext => ({
  baseUrl: "https://example.com",
  environment: "local",
  config,
  pages,
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  logger: { debug: () => undefined },
});

describe("functionality.crawl-coverage", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((c) => c.id)).toContain("functionality.crawl-coverage");
  });

  it("passes when the crawl was not capped", async () => {
    const outcome = await crawlCoverageCheck.run(
      contextWith(fixturePageStore([{ url: "https://example.com/" }])),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns with partial-coverage guidance when the crawl was capped", async () => {
    const outcome = await crawlCoverageCheck.run(
      contextWith(fixturePageStore([{ url: "https://example.com/" }], { capped: true })),
    );
    expect(outcome.score).toBe(50);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("200");
    expect(outcome.findings[0]?.recommendation).toContain("maxPages");
  });
});
