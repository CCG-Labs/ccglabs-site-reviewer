import { describe, expect, it } from "vitest";
import { axeCheck } from "../src/checks/accessibility/axe.js";
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

describe("accessibility.axe", () => {
  it("is a registered, non-blocking browser-requiring built-in", () => {
    const check = builtinChecks.find((c) => c.id === "accessibility.axe");
    expect(check?.requires).toBe("browser");
    expect(check?.blocking).toBe(false);
    expect(check?.category).toBe("accessibility");
  });

  it("passes a page with no violations", async () => {
    const outcome = await axeCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": { axe: { available: true, violations: [] } },
      }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("maps critical/serious to error, moderate to warning, minor to info", async () => {
    const outcome = await axeCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": {
          axe: {
            available: true,
            violations: [
              {
                id: "image-alt",
                impact: "critical",
                help: "Images must have alt text",
                nodeCount: 2,
              },
              { id: "color-contrast", impact: "moderate", help: "Contrast", nodeCount: 1 },
              { id: "region", impact: "minor", help: "Landmarks", nodeCount: 1 },
            ],
          },
        },
      }),
    );
    const bySeverity = (s: string) => outcome.findings.filter((f) => f.severity === s);
    expect(bySeverity("error")[0]?.message).toContain("image-alt");
    expect(bySeverity("warning")[0]?.message).toContain("color-contrast");
    expect(bySeverity("info")[0]?.message).toContain("region");
    expect(outcome.score).toBe(0); // 1 page, has an error-severity violation
  });

  it("warns (not fails) when @axe-core/playwright is not installed", async () => {
    const outcome = await axeCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": { axe: { available: false, violations: [] } },
      }),
    );
    expect(outcome.score).toBe(100);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("axe-core");
    expect(outcome.findings[0]?.recommendation).toContain("@axe-core/playwright");
  });

  it("passes standard/ignore options through to runAxe", async () => {
    let seen: { standard?: string[]; ignore?: string[] } | undefined;
    const browser = fakeBrowser({});
    const original = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await original();
      const realRunAxe = page.runAxe.bind(page);
      page.runAxe = (options) => {
        seen = options;
        return realRunAxe(options);
      };
      return page;
    };
    const ctx: CheckContext = {
      ...contextFor(
        [{ url: "https://x.com/" }],
        {},
        config({
          checks: {
            "accessibility.axe": {
              options: { standard: ["wcag2aaa"], ignore: ["color-contrast"] },
            },
          },
        }),
      ),
      browser,
    };
    await axeCheck.run(ctx);
    expect(seen).toEqual({ standard: ["wcag2aaa"], ignore: ["color-contrast"] });
  });

  it("returns 100 when the browser provider is absent", async () => {
    const ctx = contextFor([{ url: "https://x.com/" }], {});
    expect(await axeCheck.run({ ...ctx, browser: undefined })).toEqual({
      score: 100,
      findings: [],
    });
  });

  it("returns 100 for an empty store", async () => {
    expect(await axeCheck.run(contextFor([], {}))).toEqual({ score: 100, findings: [] });
  });
});
