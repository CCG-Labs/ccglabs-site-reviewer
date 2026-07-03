import { afterEach, describe, expect, it } from "vitest";
import { SiteUnreachableError } from "../src/fetch/fetcher.js";
import { runReview } from "../src/engine/run-review.js";
import { reviewReportSchema } from "../src/report/schema.js";
import type { Check } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("runReview", () => {
  it("produces a schema-valid passing report for a healthy site", async () => {
    server = await startServer((_req, res) => {
      res.end("<html></html>");
    });
    const report = await runReview({ url: server.url });
    expect(() => reviewReportSchema.parse(report)).not.toThrow();
    expect(report.grade).toBe("pass");
    expect(report.score).toBe(100);
    expect(report.environment).toBe("local");
    expect(report.target).toBe(server.url);
    expect(report.manualChecklist.length).toBeGreaterThan(0);
    const category = report.categories.find((c) => c.id === "functionality");
    expect(category?.checks.map((c) => c.id)).toContain("functionality.reachable");
  });

  it("grades fail when a blocking check fails", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("broken");
    });
    const report = await runReview({ url: server.url });
    expect(report.grade).toBe("fail");
  });

  it("throws SiteUnreachableError for a network-level failure", async () => {
    await expect(runReview({ url: "http://127.0.0.1:1" })).rejects.toBeInstanceOf(
      SiteUnreachableError,
    );
  });

  it("runs custom checks and skips those not applicable to the environment", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const productionOnly: Check = {
      id: "custom.production-only",
      category: "operations",
      description: "only runs in production",
      environments: ["production"],
      blocking: false,
      weight: 1,
      run: () => Promise.resolve({ score: 100, findings: [] }),
    };
    const report = await runReview({
      url: server.url,
      environment: "local",
      config: { customChecks: [productionOnly] },
    });
    expect(report.skipped).toContainEqual({
      id: "custom.production-only",
      reason: 'not applicable in environment "local"',
    });
  });

  it("honors config overrides that disable a check", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const report = await runReview({
      url: server.url,
      config: { checks: { "functionality.reachable": false } },
    });
    expect(report.skipped).toContainEqual({
      id: "functionality.reachable",
      reason: "disabled by config",
    });
    expect(report.grade).toBe("pass");
  });
});
