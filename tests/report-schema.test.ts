import { describe, expect, it } from "vitest";
import { REPORT_VERSION, reviewReportSchema } from "../src/report/schema.js";

const validReport = {
  reportVersion: 2,
  tool: { name: "@ccglabs/site-reviewer", version: "0.1.0" },
  target: "https://example.com",
  environment: "production",
  startedAt: "2026-07-03T12:00:00.000Z",
  durationMs: 1234,
  crawl: { pagesDiscovered: 43, pagesScanned: 43, capped: false },
  grade: "pass",
  score: 92,
  categories: [
    {
      id: "functionality",
      score: 92,
      checks: [
        {
          id: "functionality.reachable",
          status: "pass",
          score: 100,
          blocking: true,
          findings: [],
          debug: [{ message: "Fetched base URL", data: { status: 200 } }],
        },
      ],
    },
  ],
  skipped: [{ id: "security.tls", reason: 'not applicable in environment "local"' }],
  manualChecklist: ["Submit sitemap in Google Search Console"],
};

describe("reviewReportSchema", () => {
  it("accepts a valid report", () => {
    expect(reviewReportSchema.parse(validReport)).toEqual(validReport);
  });

  it("rejects a report with the wrong version", () => {
    expect(() => reviewReportSchema.parse({ ...validReport, reportVersion: 99 })).toThrow();
  });

  it("rejects an out-of-range score", () => {
    expect(() => reviewReportSchema.parse({ ...validReport, score: 101 })).toThrow();
  });

  it("rejects findings missing a recommendation", () => {
    const bad = structuredClone(validReport);
    // @ts-expect-error testing invalid schema
    bad.categories[0].checks[0].findings = [{ severity: "error", message: "broken" }];
    expect(() => reviewReportSchema.parse(bad)).toThrow();
  });

  it("pins REPORT_VERSION so schema changes force a deliberate bump", () => {
    expect(REPORT_VERSION).toBe(2);
  });

  it("rejects a report missing the crawl block", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { crawl: _crawl, ...withoutCrawl } = validReport;
    expect(() => reviewReportSchema.parse(withoutCrawl)).toThrow();
  });
});
