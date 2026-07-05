import { describe, expect, it } from "vitest";
import { applyOverride, partitionChecks, runChecks } from "../src/engine/runner.js";
import type { Check, CheckContext, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const makeCheck = (overrides: Partial<Check>): Check => ({
  id: "test.check",
  category: "functionality",
  description: "test",
  environments: ["local", "ci", "production"],
  blocking: false,
  weight: 1,
  run: () => Promise.resolve({ score: 100, findings: [] }),
  ...overrides,
});

const config: ResolvedConfig = {
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  browserSampleSize: 5,
  requestHeaders: {},
  checks: {},
  customChecks: [],
};

const base: Omit<CheckContext, "logger"> = {
  baseUrl: "http://example.test",
  environment: "local",
  config,
  pages: fixturePageStore(),
  fetch: () => Promise.reject(new Error("no fetch in this test")),
};

describe("partitionChecks", () => {
  it("skips checks not applicable to the environment, with a reason", () => {
    const { toRun, skipped } = partitionChecks(
      [makeCheck({ id: "a", environments: ["production"] }), makeCheck({ id: "b" })],
      "local",
      {},
    );
    expect(toRun.map((c) => c.id)).toEqual(["b"]);
    expect(skipped).toEqual([{ id: "a", reason: 'not applicable in environment "local"' }]);
  });

  it("skips checks disabled by config", () => {
    const { toRun, skipped } = partitionChecks([makeCheck({ id: "a" })], "local", {
      a: { enabled: false },
    });
    expect(toRun).toEqual([]);
    expect(skipped).toEqual([{ id: "a", reason: "disabled by config" }]);
  });
});

describe("applyOverride", () => {
  it("overrides blocking and weight", () => {
    const check = applyOverride(makeCheck({ blocking: false, weight: 1 }), {
      blocking: true,
      weight: 4,
    });
    expect(check.blocking).toBe(true);
    expect(check.weight).toBe(4);
  });
  it("returns the check unchanged without an override", () => {
    const check = makeCheck({});
    expect(applyOverride(check)).toBe(check);
  });
});

describe("runChecks", () => {
  it("derives status from findings and captures debug logs", async () => {
    const check = makeCheck({
      run: (ctx) => {
        ctx.logger.debug("looked at page", { n: 1 });
        return Promise.resolve({
          score: 40,
          findings: [{ severity: "error" as const, message: "broken", recommendation: "fix" }],
        });
      },
    });
    const [executed] = await runChecks([check], base);
    expect(executed?.status).toBe("fail");
    expect(executed?.score).toBe(40);
    expect(executed?.debug).toEqual([{ message: "looked at page", data: { n: 1 } }]);
  });

  it("reports a crashing check as status error without failing the run", async () => {
    const boom = makeCheck({ id: "boom", run: () => Promise.reject(new Error("kaput")) });
    const ok = makeCheck({ id: "ok" });
    const executed = await runChecks([boom, ok], base);
    expect(executed.map((e) => e.status).sort()).toEqual(["error", "pass"]);
    const errored = executed.find((e) => e.status === "error");
    expect(errored?.findings[0]?.message).toContain("kaput");
  });

  it("times out slow checks as status error", async () => {
    const slow = makeCheck({
      id: "slow",
      run: () => new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)) as never,
    });
    const [executed] = await runChecks([slow], base, 50);
    expect(executed?.status).toBe("error");
    expect(executed?.findings[0]?.message).toContain("timed out");
  });

  it("clamps out-of-range scores", async () => {
    const [executed] = await runChecks(
      [makeCheck({ run: () => Promise.resolve({ score: 250, findings: [] }) })],
      base,
    );
    expect(executed?.score).toBe(100);
  });
});
