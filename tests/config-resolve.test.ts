import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve.js";

describe("resolveConfig", () => {
  it("returns defaults when no layers are provided", () => {
    expect(resolveConfig({})).toEqual({
      environment: "local",
      maxPages: 200,
      failThreshold: 80,
      requestHeaders: {},
      checks: {},
      customChecks: [],
    });
  });

  it("applies precedence file < api < cli", () => {
    const config = resolveConfig({
      file: { failThreshold: 70, maxPages: 50 },
      api: { failThreshold: 75 },
      cli: { maxPages: 10 },
    });
    expect(config.failThreshold).toBe(75);
    expect(config.maxPages).toBe(10);
  });

  it("applies per-environment overrides for the active environment only", () => {
    const config = resolveConfig({
      file: {
        failThreshold: 70,
        environments: { production: { failThreshold: 95 }, ci: { failThreshold: 60 } },
      },
      cli: { environment: "production" },
    });
    expect(config.environment).toBe("production");
    expect(config.failThreshold).toBe(95);
  });

  it("normalizes boolean check overrides and merges layered overrides per check", () => {
    const config = resolveConfig({
      file: { checks: { "seo.meta-tags": { weight: 2 } } },
      api: { checks: { "seo.meta-tags": false } },
    });
    expect(config.checks["seo.meta-tags"]).toEqual({ weight: 2, enabled: false });
  });

  it("concatenates customChecks across layers", () => {
    const makeCheck = (id: string) => ({
      id,
      category: "seo" as const,
      description: id,
      environments: ["local" as const],
      blocking: false,
      weight: 1,
      run: () => Promise.resolve({ score: 100, findings: [] }),
    });
    const config = resolveConfig({
      file: { customChecks: [makeCheck("a")] },
      api: { customChecks: [makeCheck("b")] },
    });
    expect(config.customChecks.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
