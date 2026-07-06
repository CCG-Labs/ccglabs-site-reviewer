import { describe, expect, it } from "vitest";
import type { LighthouseRun } from "../src/browser/types.js";
import { lighthouseCheck } from "../src/checks/performance/lighthouse.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";
import { fakeBrowser, type FakePageScript } from "./helpers/fake-browser.js";

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  environment: "ci",
  maxPages: 200,
  failThreshold: 80,
  browserSampleSize: 5,
  requestHeaders: {},
  checks: {},
  customChecks: [],
  ...overrides,
});

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  scripts: Record<string, FakePageScript>,
  cfg: ResolvedConfig = config(),
): CheckContext => ({
  baseUrl: "https://x.com/",
  environment: "ci",
  config: cfg,
  pages: fixturePageStore(pages),
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  browser: fakeBrowser(scripts),
  logger: { debug: () => undefined },
});

const GOOD: LighthouseRun = {
  available: true,
  categories: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100 },
  metrics: { lcpMs: 1000, cls: 0, tbtMs: 0 },
};

const withPerformance = (score: number | null): LighthouseRun => ({
  ...GOOD,
  categories: { ...GOOD.categories, performance: score },
});

const withLcp = (lcpMs: number): LighthouseRun => ({
  ...GOOD,
  metrics: { ...GOOD.metrics, lcpMs },
});

describe("performance.lighthouse", () => {
  it("is a registered, non-blocking browser-requiring built-in with the expected environments", () => {
    const check = builtinChecks.find((c) => c.id === "performance.lighthouse");
    expect(check?.id).toBe("performance.lighthouse");
    expect(check?.category).toBe("performance");
    expect(check?.requires).toBe("browser");
    expect(check?.blocking).toBe(false);
    expect(check?.weight).toBe(1);
    expect(check?.environments).toEqual(["ci", "production"]);
  });

  it("returns 100 when the browser provider is absent", async () => {
    const ctx = contextFor([{ url: "https://x.com/" }], {});
    expect(await lighthouseCheck.run({ ...ctx, browser: undefined })).toEqual({
      score: 100,
      findings: [],
    });
  });

  it("warns once when lighthouse is not installed", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": {
          lighthouse: {
            available: false,
            categories: {
              performance: null,
              accessibility: null,
              bestPractices: null,
              seo: null,
            },
            metrics: { lcpMs: null, cls: null, tbtMs: null },
          },
        },
      }),
    );
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.severity).toBe("warning");
    expect(finding?.url).toBe("https://x.com/");
    expect(finding?.message.toLowerCase()).toContain("lighthouse");
    expect(finding?.recommendation).toContain("npm i -D lighthouse");
    expect(outcome.score).toBe(100);
  });

  it("has no findings for a perfect (default fake) run", async () => {
    const outcome = await lighthouseCheck.run(contextFor([{ url: "https://x.com/" }], {}));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("gives a category advisory when performance is below the default 90 threshold and no budget is configured", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": { lighthouse: withPerformance(72) },
      }),
    );
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("Performance");
    expect(finding?.message).toContain("72");
    expect(finding?.message).toContain("Lab data");
    expect(outcome.score).toBe(95);
  });

  it("errors when a configured minScores budget is breached", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor(
        [{ url: "https://x.com/" }],
        { "https://x.com/": { lighthouse: withPerformance(72) } },
        config({
          checks: { "performance.lighthouse": { options: { minScores: { performance: 80 } } } },
        }),
      ),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("error");
    expect(outcome.score).toBe(80);
  });

  it("has no finding when the configured minScores budget is met", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor(
        [{ url: "https://x.com/" }],
        { "https://x.com/": { lighthouse: withPerformance(72) } },
        config({
          checks: { "performance.lighthouse": { options: { minScores: { performance: 60 } } } },
        }),
      ),
    );
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.score).toBe(100);
  });

  it("gives a metric advisory when LCP is over the default 2500ms threshold", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": { lighthouse: withLcp(4000) },
      }),
    );
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("LCP");
    expect(finding?.message).toContain("4000 ms");
    expect(finding?.message).toContain("2500 ms");
    expect(outcome.score).toBe(95);
  });

  it("errors when a configured maxMetrics budget is breached", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor(
        [{ url: "https://x.com/" }],
        { "https://x.com/": { lighthouse: withLcp(4000) } },
        config({
          checks: { "performance.lighthouse": { options: { maxMetrics: { lcpMs: 3000 } } } },
        }),
      ),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("error");
    expect(outcome.score).toBe(80);
  });

  it("skips a null category score without crashing", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": { lighthouse: withPerformance(null) },
      }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns once when runLighthouse rejects", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": { throwOnLighthouse: "PROTOCOL_TIMEOUT" },
      }),
    );
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("could not complete");
    expect(finding?.message).toContain("PROTOCOL_TIMEOUT");
    // Unlike the hardcoded score:100 "not installed" branch, a scan-rejection
    // warning flows through the closing formula (100 - 5*warnings).
    expect(outcome.score).toBe(95);
  });

  it("audits configured extra urls, scoping findings to the url that breached", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor(
        [{ url: "https://x.com/" }],
        {
          "https://x.com/": { lighthouse: GOOD },
          "https://x.com/pricing": { lighthouse: withPerformance(72) },
        },
        config({
          checks: { "performance.lighthouse": { options: { urls: ["https://x.com/pricing"] } } },
        }),
      ),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.url).toBe("https://x.com/pricing");
  });

  it("reports the median of multiple runs, producing a single finding", async () => {
    const outcome = await lighthouseCheck.run(
      contextFor(
        [{ url: "https://x.com/" }],
        {
          "https://x.com/": {
            lighthouse: [withPerformance(40), withPerformance(60), withPerformance(50)],
          },
        },
        config({ checks: { "performance.lighthouse": { options: { runs: 3 } } } }),
      ),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.message).toContain("50");
    expect(outcome.score).toBe(95); // one default-90 advisory warning on the median score
  });
});
