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

  it("warns on a page that fails to load and still scans the remaining pages", async () => {
    const outcome = await axeCheck.run(
      contextFor([{ url: "https://x.com/" }, { url: "https://x.com/two" }], {
        "https://x.com/": { throwOnGoto: "net::ERR_TIMED_OUT" },
        "https://x.com/two": {
          axe: {
            available: true,
            violations: [
              {
                id: "image-alt",
                impact: "critical",
                help: "Images must have alt text",
                nodeCount: 1,
              },
            ],
          },
        },
      }),
    );
    const warning = outcome.findings.find((f) => f.severity === "warning");
    expect(warning?.url).toBe("https://x.com/");
    expect(warning?.message).toContain("could not be loaded");
    const error = outcome.findings.find((f) => f.severity === "error");
    expect(error?.url).toBe("https://x.com/two");
    expect(error?.message).toContain("image-alt");
    expect(outcome.score).toBe(50); // 2 pages, only /two has an error-severity violation
  });

  it("maps serious to error and null impact to info", async () => {
    const outcome = await axeCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": {
          axe: {
            available: true,
            violations: [
              {
                id: "aria-hidden-focus",
                impact: "serious",
                help: "ARIA hidden focus",
                nodeCount: 1,
              },
              { id: "unknown-rule", impact: null, help: "No impact reported", nodeCount: 1 },
            ],
          },
        },
      }),
    );
    const bySeverity = (s: string) => outcome.findings.filter((f) => f.severity === s);
    expect(bySeverity("error")[0]?.message).toContain("aria-hidden-focus");
    expect(bySeverity("info")[0]?.message).toContain("unknown-rule");
    expect(bySeverity("info")[0]?.message).toContain("(unknown)");
    expect(outcome.score).toBe(0); // serious dirties the page
  });

  it("scores 100 when a page has only moderate and minor violations", async () => {
    const outcome = await axeCheck.run(
      contextFor([{ url: "https://x.com/" }], {
        "https://x.com/": {
          axe: {
            available: true,
            violations: [
              { id: "color-contrast", impact: "moderate", help: "Contrast", nodeCount: 3 },
              { id: "region", impact: "minor", help: "Landmarks", nodeCount: 2 },
            ],
          },
        },
      }),
    );
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings.every((f) => f.severity !== "error")).toBe(true);
    expect(outcome.score).toBe(100); // warnings/info do not dirty a page
  });

  it("stops scanning remaining pages once axe reports unavailable", async () => {
    let runAxeCalls = 0;
    const browser = fakeBrowser({
      "https://x.com/": { axe: { available: false, violations: [] } },
      "https://x.com/two": {
        axe: {
          available: true,
          violations: [
            {
              id: "image-alt",
              impact: "critical",
              help: "Images must have alt text",
              nodeCount: 1,
            },
          ],
        },
      },
    });
    const original = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await original();
      const realRunAxe = page.runAxe.bind(page);
      page.runAxe = (options) => {
        runAxeCalls += 1;
        return realRunAxe(options);
      };
      return page;
    };
    const ctx: CheckContext = {
      ...contextFor([{ url: "https://x.com/" }, { url: "https://x.com/two" }], {}),
      browser,
    };
    const outcome = await axeCheck.run(ctx);
    expect(outcome.score).toBe(100);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.url).toBe("https://x.com/");
    expect(outcome.findings[0]?.message).toContain("axe-core");
    expect(runAxeCalls).toBe(1); // page two was never scanned
  });
});
