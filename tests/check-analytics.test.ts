import { describe, expect, it } from "vitest";
import { analyticsCheck } from "../src/checks/operations/analytics.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";
import { fakeBrowser, type FakePageScript } from "./helpers/fake-browser.js";

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  environment: "production",
  maxPages: 200,
  failThreshold: 80,
  browserSampleSize: 5,
  requestHeaders: {},
  checks: {},
  customChecks: [],
  ...overrides,
});

/** Every test needs settleMs: 0 so the check never waits on a real timer. */
const optionsConfig = (options: Record<string, unknown>): ResolvedConfig =>
  config({
    checks: {
      "operations.analytics": {
        options: { settleMs: 0, ...options },
      },
    },
  });

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  scripts: Record<string, FakePageScript>,
  cfg: ResolvedConfig,
): CheckContext => ({
  baseUrl: "https://x.com/",
  environment: "production",
  config: cfg,
  pages: fixturePageStore(pages),
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  browser: fakeBrowser(scripts),
  logger: { debug: () => undefined },
});

const GA4_HIT = "https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view";

describe("operations.analytics", () => {
  it("is registered with the expected metadata", () => {
    const check = builtinChecks.find((c) => c.id === "operations.analytics");
    expect(check?.category).toBe("operations");
    expect(check?.requires).toBe("browser");
    expect(check?.blocking).toBe(false);
    expect(check?.weight).toBe(1);
    expect(check?.environments).toEqual(["production"]);
  });

  it("returns 100 when the browser provider is absent", async () => {
    const ctx = contextFor([{ url: "https://x.com/" }], {}, optionsConfig({}));
    expect(await analyticsCheck.run({ ...ctx, browser: undefined })).toEqual({
      score: 100,
      findings: [],
    });
  });

  it("returns 100 for an empty page store (base URL not crawled)", async () => {
    const ctx = contextFor([], {}, optionsConfig({}));
    expect(await analyticsCheck.run(ctx)).toEqual({ score: 100, findings: [] });
  });

  it("auto-detects a GA4 hit with no findings", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      { "https://x.com/": { requests: [{ url: GA4_HIT, method: "GET" }] } },
      optionsConfig({}),
    );
    expect(await analyticsCheck.run(ctx)).toEqual({ score: 100, findings: [] });
  });

  it("warns per page with no analytics hits and scores 0 for a single-page store", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      { "https://x.com/": { requests: [{ url: "https://x.com/app.js", method: "GET" }] } },
      optionsConfig({}),
    );
    const outcome = await analyticsCheck.run(ctx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("No analytics hits");
    expect(outcome.score).toBe(0);
  });

  it("warns that the tag script loaded but no events fired", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [
            { url: "https://www.googletagmanager.com/gtag/js?id=G-ABC123", method: "GET" },
          ],
        },
      },
      optionsConfig({}),
    );
    const outcome = await analyticsCheck.run(ctx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.message).toContain("loaded");
    expect(outcome.findings[0]?.message).toContain("no events fired");
    expect(outcome.findings[0]?.message.toLowerCase()).toMatch(/consent manager|blocker/);
    expect(outcome.score).toBe(0);
  });

  it("warns naming both the observed and expected property IDs", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [
            {
              url: "https://region1.google-analytics.com/g/collect?v=2&tid=G-STAGING1&en=page_view",
              method: "GET",
            },
          ],
        },
      },
      optionsConfig({ propertyId: "G-PROD456" }),
    );
    const outcome = await analyticsCheck.run(ctx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.message).toContain("G-STAGING1");
    expect(outcome.findings[0]?.message).toContain("G-PROD456");
    expect(outcome.score).toBe(0);
  });

  it("matches the configured property ID case-insensitively with no findings", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      { "https://x.com/": { requests: [{ url: GA4_HIT, method: "GET" }] } },
      optionsConfig({ propertyId: "g-abc123" }),
    );
    expect(await analyticsCheck.run(ctx)).toEqual({ score: 100, findings: [] });
  });

  it("warns on double-firing but not on two distinct event types", async () => {
    const doubleCtx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [
            { url: GA4_HIT, method: "GET" },
            { url: GA4_HIT, method: "GET" },
          ],
        },
      },
      optionsConfig({}),
    );
    const doubleOutcome = await analyticsCheck.run(doubleCtx);
    expect(doubleOutcome.findings).toHaveLength(1);
    expect(doubleOutcome.findings[0]?.message).toContain("installed twice");
    expect(doubleOutcome.score).toBe(0);

    const distinctCtx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [
            { url: GA4_HIT, method: "GET" },
            {
              url: "https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=scroll",
              method: "GET",
            },
          ],
        },
      },
      optionsConfig({}),
    );
    expect(await analyticsCheck.run(distinctCtx)).toEqual({ score: 100, findings: [] });
  });

  it("auto-detects Plausible hits and flags double POSTs", async () => {
    const singleCtx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": { requests: [{ url: "https://plausible.io/api/event", method: "POST" }] },
      },
      optionsConfig({}),
    );
    expect(await analyticsCheck.run(singleCtx)).toEqual({ score: 100, findings: [] });

    const doubleCtx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [
            { url: "https://plausible.io/api/event", method: "POST" },
            { url: "https://plausible.io/api/event", method: "POST" },
          ],
        },
      },
      optionsConfig({}),
    );
    const outcome = await analyticsCheck.run(doubleCtx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.message).toContain("installed twice");
    expect(outcome.score).toBe(0);
  });

  it("detects Fathom hits and flags a wrong site ID naming it", async () => {
    const okCtx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [{ url: "https://usefathom.com/?sid=FATHOM99&p=%2F", method: "GET" }],
        },
      },
      optionsConfig({}),
    );
    expect(await analyticsCheck.run(okCtx)).toEqual({ score: 100, findings: [] });

    const wrongCtx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [{ url: "https://usefathom.com/?sid=FATHOM99&p=%2F", method: "GET" }],
        },
      },
      optionsConfig({ propertyId: "OTHER1" }),
    );
    const outcome = await analyticsCheck.run(wrongCtx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.message).toContain("FATHOM99");
    expect(outcome.findings[0]?.message).toContain("OTHER1");
    expect(outcome.score).toBe(0);
  });

  it("ignores GA4 hits when restricted to a different configured provider", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      { "https://x.com/": { requests: [{ url: GA4_HIT, method: "GET" }] } },
      optionsConfig({ provider: "plausible" }),
    );
    const outcome = await analyticsCheck.run(ctx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.message).toContain("No analytics hits");
    expect(outcome.score).toBe(0);
  });

  it("counts custom configured hosts as hits", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [{ url: "https://matomo.example.com/matomo.php?idsite=3", method: "GET" }],
        },
      },
      optionsConfig({ hosts: ["matomo.example.com"] }),
    );
    expect(await analyticsCheck.run(ctx)).toEqual({ score: 100, findings: [] });
  });

  it("custom hosts exempt from double-fire detection on loader+beacon", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }],
      {
        "https://x.com/": {
          requests: [
            { url: "https://stats.example.com/js/script.js", method: "GET" },
            { url: "https://stats.example.com/api/event", method: "POST" },
          ],
        },
      },
      optionsConfig({ hosts: ["stats.example.com"] }),
    );
    expect(await analyticsCheck.run(ctx)).toEqual({ score: 100, findings: [] });
  });

  it("warns on a page that fails to load without dirtying the run", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }, { url: "https://x.com/two" }],
      {
        "https://x.com/": { throwOnGoto: "net::ERR_TIMED_OUT" },
        "https://x.com/two": { requests: [{ url: GA4_HIT, method: "GET" }] },
      },
      optionsConfig({}),
    );
    const outcome = await analyticsCheck.run(ctx);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.url).toBe("https://x.com/");
    expect(outcome.findings[0]?.message).toContain("could not be loaded");
    expect(outcome.score).toBe(100);
  });

  it("samples the base page plus exactly one deep page", async () => {
    const ctx = contextFor(
      [{ url: "https://x.com/" }, { url: "https://x.com/a" }, { url: "https://x.com/b" }],
      {},
      optionsConfig({}),
    );
    const outcome = await analyticsCheck.run(ctx);
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings.every((f) => f.message.includes("No analytics hits"))).toBe(true);
    expect(outcome.score).toBe(0);
  });
});
