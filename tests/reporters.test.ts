import { describe, expect, it } from "vitest";
import { renderConsole } from "../src/reporters/console.js";
import { renderJson } from "../src/reporters/json.js";
import type { ReviewReport } from "../src/report/schema.js";

const report: ReviewReport = {
  reportVersion: 1,
  tool: { name: "@ccglabs/site-reviewer", version: "0.1.0" },
  target: "https://example.com",
  environment: "ci",
  startedAt: "2026-07-03T12:00:00.000Z",
  durationMs: 900,
  grade: "fail",
  score: 61,
  categories: [
    {
      id: "seo",
      score: 61,
      checks: [
        {
          id: "seo.meta-tags",
          status: "fail",
          score: 55,
          blocking: true,
          findings: [
            {
              severity: "error",
              url: "https://example.com/about",
              message: "Duplicate <title> shared with /team",
              recommendation: "Give each page a unique title under 60 characters.",
            },
          ],
          debug: [],
        },
      ],
    },
  ],
  skipped: [{ id: "security.tls", reason: 'not applicable in environment "ci"' }],
  manualChecklist: ["Submit the sitemap in Google Search Console"],
};

describe("renderJson", () => {
  it("round-trips the report", () => {
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });
});

describe("renderConsole", () => {
  it("includes grade, score, findings, recommendations, and skips", () => {
    const text = renderConsole(report);
    expect(text).toContain("FAIL");
    expect(text).toContain("61/100");
    expect(text).toContain("seo.meta-tags");
    expect(text).toContain("Duplicate <title> shared with /team");
    expect(text).toContain("Give each page a unique title");
    expect(text).toContain("security.tls");
  });
});
