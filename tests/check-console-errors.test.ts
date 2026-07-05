import { describe, expect, it } from "vitest";
import { consoleErrorsCheck } from "../src/checks/functionality/console-errors.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";
import { fakeBrowser } from "./helpers/fake-browser.js";
import type { FakePageScript } from "./helpers/fake-browser.js";

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

describe("functionality.console-errors", () => {
  it("is a registered browser-requiring built-in", () => {
    const check = builtinChecks.find((c) => c.id === "functionality.console-errors");
    expect(check?.requires).toBe("browser");
    expect(check?.blocking).toBe(true);
  });

  it("passes a clean page", async () => {
    const outcome = await consoleErrorsCheck.run(
      contextFor([{ url: "https://x.com/" }], { "https://x.com/": { status: 200 } }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags uncaught JS errors as errors and failed requests as warnings", async () => {
    const outcome = await consoleErrorsCheck.run(
      contextFor([{ url: "https://x.com/" }, { url: "https://x.com/a" }], {
        "https://x.com/": { errors: ["Uncaught TypeError: boom"] },
        "https://x.com/a": {
          failedRequests: [{ url: "https://x.com/app.js", failure: "net::ERR_ABORTED" }],
        },
      }),
    );
    const errors = outcome.findings.filter((f) => f.severity === "error");
    const warnings = outcome.findings.filter((f) => f.severity === "warning");
    expect(errors[0]?.url).toBe("https://x.com/");
    expect(errors[0]?.message).toContain("boom");
    expect(warnings[0]?.url).toBe("https://x.com/a");
    expect(outcome.score).toBe(50); // 1 of 2 pages has an error
  });

  it("honors the ignore option", async () => {
    const outcome = await consoleErrorsCheck.run(
      contextFor(
        [{ url: "https://x.com/" }],
        {
          "https://x.com/": { errors: ["Noisy third-party analytics.js error"] },
        },
        config({
          checks: { "functionality.console-errors": { options: { ignore: ["analytics.js"] } } },
        }),
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns when a page cannot be loaded in the browser and still evaluates the rest", async () => {
    const outcome = await consoleErrorsCheck.run(
      contextFor([{ url: "https://x.com/" }, { url: "https://x.com/a" }], {
        "https://x.com/": { throwOnGoto: "net::ERR_TIMED_OUT navigating" },
        "https://x.com/a": { errors: ["Uncaught TypeError: boom"] },
      }),
    );
    const navWarning = outcome.findings.find(
      (f) => f.severity === "warning" && f.url === "https://x.com/",
    );
    expect(navWarning?.message).toContain("could not be loaded");
    expect(navWarning?.message).toContain("net::ERR_TIMED_OUT");
    // the run completed: the second page was still evaluated and flagged
    expect(
      outcome.findings.some((f) => f.severity === "error" && f.url === "https://x.com/a"),
    ).toBe(true);
  });

  it("returns 100 when the browser provider is absent", async () => {
    const ctx = contextFor([{ url: "https://x.com/" }], {});
    const outcome = await consoleErrorsCheck.run({ ...ctx, browser: undefined });
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
