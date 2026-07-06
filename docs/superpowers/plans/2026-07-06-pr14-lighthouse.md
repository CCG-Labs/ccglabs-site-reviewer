# PR 14: performance.lighthouse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `performance.lighthouse` check — Lighthouse category scores + Core Web Vitals over the shared Playwright Chromium via CDP, with advisory-by-default budgets.

**Architecture:** The driver launches Chromium with `--remote-debugging-port=<OS-assigned free port>` (bound to 127.0.0.1) and exposes `BrowserProvider.runLighthouse(url)` — the sole dynamic `import("lighthouse")`, mirroring the `runAxe` seam. The check runs Lighthouse on the base URL (plus optional `urls`), maps category scores and LCP/CLS/TBT to findings (warning at Lighthouse's own green thresholds; error only when the user configures explicit budgets), and scores with the deduction model.

**Tech Stack:** lighthouse >=11 <13 (optional peer, devDep for self-testing), playwright (existing), vitest, fake-browser test double.

## Spec Deviation (flagged)

The browser-tier spec sketched `cdpEndpoint(): Promise<string>` on `BrowserProvider`. This plan instead keeps the CDP port private to the driver and exposes `runLighthouse(url)`, exactly as PR 13 evolved axe into `BrowserPage.runAxe` rather than exposing the page handle. Same capability, smaller public surface, and checks stay testable against the fake without CDP machinery.

## Global Constraints

- TypeScript strict; NO `any`; zero eslint-disable/ts-expect-error (lighthouse ships its own types).
- `import("lighthouse")` appears ONLY in `src/browser/playwright-driver.ts`. No `eval`, no `child_process`. The debug port binds 127.0.0.1 only (Chromium default for `--remote-debugging-port`).
- Import failure → `{ available: false, ... }`; the check turns that into ONE warning at baseUrl + score 100 (never a silent pass, never a failure).
- Check: id `performance.lighthouse`, category `performance`, `requires: "browser"`, `blocking: false`, `weight: 1`, `environments: ["ci", "production"]` (lab perf on a local dev server is unrepresentative; overridable via config env overrides).
- Advisory by default: category score < 90 → **warning**; LCP > 2500 ms / CLS > 0.1 / TBT > 200 ms → **warning**. A user-configured `minScores`/`maxMetrics` budget breach → **error**. Every finding message carries the lab-data caveat.
- Scoring: deduction model `Math.max(0, 100 - 20*errors - 5*warnings)`.
- Per-URL failures (goto-equivalent: `runLighthouse` rejection) → warning + continue; never destroy the report.
- Unit tests use `tests/helpers/fake-browser.ts`; real-Chromium suites self-skip via `probeBrowserCapability()`.
- `npm run format && npm run verify` green after every task; commit per task.

---

### Task 1: runLighthouse seam (types + fake + driver + lazy forwarding + smoke test)

**Files:**
- Modify: `src/browser/types.ts`
- Modify: `src/browser/playwright-driver.ts`
- Modify: `src/browser/lazy-browser.ts`
- Modify: `tests/helpers/fake-browser.ts`
- Modify: `package.json` (devDep only — peer/meta/tsup already declare lighthouse since PR 12)
- Test: `tests/fake-browser.test.ts`, `tests/browser/driver-smoke.test.ts`

**Interfaces:**
- Produces: `LighthouseRun`, `BrowserProvider.runLighthouse(url: string): Promise<LighthouseRun>`, `FakePageScript.lighthouse?: LighthouseRun | LighthouseRun[]`, `FakePageScript.throwOnLighthouse?: string`.

**Lesson from PR 13:** adding a method to a browser interface forces the driver, lazy wrapper, AND fake to implement it in the same commit — this task deliberately bundles all of them.

- [ ] **Step 1: Install the devDep**

```bash
npm install --save-dev lighthouse
```

Verify the installed version satisfies the existing peer range `>=11 <13`.

- [ ] **Step 2: Write the failing fake-browser tests**

Append to `tests/fake-browser.test.ts` (match the existing runAxe tests' style):

```ts
it("replays a scripted lighthouse result", async () => {
  const lighthouse = {
    available: true,
    categories: { performance: 55, accessibility: 90, bestPractices: 100, seo: 100 },
    metrics: { lcpMs: 3100, cls: 0.02, tbtMs: 150 },
  };
  const browser = fakeBrowser({ "https://x.com/": { html: "<html></html>", lighthouse } });
  await expect(browser.runLighthouse("https://x.com/")).resolves.toEqual(lighthouse);
});

it("defaults to a perfect available lighthouse run when unscripted", async () => {
  const browser = fakeBrowser({ "https://x.com/": { html: "<html></html>" } });
  const run = await browser.runLighthouse("https://x.com/");
  expect(run.available).toBe(true);
  expect(run.categories.performance).toBe(100);
  expect(run.metrics.cls).toBe(0);
});

it("consumes an array of scripted lighthouse results in order", async () => {
  const mk = (perf: number) => ({
    available: true,
    categories: { performance: perf, accessibility: 100, bestPractices: 100, seo: 100 },
    metrics: { lcpMs: 1000, cls: 0, tbtMs: 0 },
  });
  const browser = fakeBrowser({
    "https://x.com/": { html: "<html></html>", lighthouse: [mk(40), mk(60), mk(50)] },
  });
  expect((await browser.runLighthouse("https://x.com/")).categories.performance).toBe(40);
  expect((await browser.runLighthouse("https://x.com/")).categories.performance).toBe(60);
  expect((await browser.runLighthouse("https://x.com/")).categories.performance).toBe(50);
  // array exhausted → repeats the last entry
  expect((await browser.runLighthouse("https://x.com/")).categories.performance).toBe(50);
});

it("rejects runLighthouse when scripted with throwOnLighthouse", async () => {
  const browser = fakeBrowser({
    "https://x.com/": { html: "<html></html>", throwOnLighthouse: "PROTOCOL_TIMEOUT" },
  });
  await expect(browser.runLighthouse("https://x.com/")).rejects.toThrow("PROTOCOL_TIMEOUT");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/fake-browser.test.ts`
Expected: FAIL — `runLighthouse` does not exist.

- [ ] **Step 4: Add the types**

In `src/browser/types.ts`, after `AxeRun`:

```ts
/** A distilled Lighthouse result — no lighthouse types leak past the driver seam. */
export interface LighthouseRun {
  /** false when the lighthouse peer dep could not be imported */
  available: boolean;
  /** category scores 0–100; null when Lighthouse could not score a category */
  categories: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  /** lab metrics; TBT stands in for INP (INP needs field data) */
  metrics: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
  };
}
```

And on `BrowserProvider`:

```ts
export interface BrowserProvider {
  /** a fresh isolated page; the engine tracks and closes it at teardown */
  newPage(): Promise<BrowserPage>;
  /** run Lighthouse against a URL over the shared browser's CDP port; available:false when the lighthouse peer dep is absent */
  runLighthouse(url: string): Promise<LighthouseRun>;
}
```

- [ ] **Step 5: Implement the fake**

In `tests/helpers/fake-browser.ts`: extend `FakePageScript` with

```ts
  /** scripted lighthouse result(s); an array is consumed in order (last entry repeats) */
  lighthouse?: LighthouseRun | LighthouseRun[];
  /** when set, runLighthouse rejects with this message */
  throwOnLighthouse?: string;
```

Add a default at module scope:

```ts
const PERFECT_LIGHTHOUSE: LighthouseRun = {
  available: true,
  categories: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100 },
  metrics: { lcpMs: 1000, cls: 0, tbtMs: 0 },
};
```

Implement on the returned provider (track consumption per URL in a `Map<string, number>` closure):

```ts
    runLighthouse(url: string): Promise<LighthouseRun> {
      const script = scripts[url];
      if (script?.throwOnLighthouse !== undefined) {
        return Promise.reject(new Error(script.throwOnLighthouse));
      }
      const scripted = script?.lighthouse;
      if (scripted === undefined) return Promise.resolve(PERFECT_LIGHTHOUSE);
      if (!Array.isArray(scripted)) return Promise.resolve(scripted);
      const used = lighthouseCalls.get(url) ?? 0;
      lighthouseCalls.set(url, used + 1);
      return Promise.resolve(scripted[Math.min(used, scripted.length - 1)] ?? PERFECT_LIGHTHOUSE);
    },
```

- [ ] **Step 6: Forward through the lazy browser**

In `src/browser/lazy-browser.ts`, the returned provider gains:

```ts
      async runLighthouse(url: string): Promise<LighthouseRun> {
        return (await ensure()).provider.runLighthouse(url);
      },
```

(import the `LighthouseRun` type).

- [ ] **Step 7: Implement the driver**

In `src/browser/playwright-driver.ts`:

Add at the top:

```ts
import net from "node:net";
import {
  BrowserLaunchError,
  type AxeRun,
  type BrowserPage,
  type BrowserProvider,
  type FailedRequest,
  type LighthouseRun,
} from "./types.js";

/**
 * An OS-assigned free TCP port on 127.0.0.1. Freed before Chromium binds it —
 * the TOCTOU window is negligible for a local, short-lived tool process.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a CDP debugging port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
```

Change the launch (inside the existing try/catch) to:

```ts
  const cdpPort = await freePort();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      // 127.0.0.1-bound CDP port so Lighthouse can drive this same Chromium.
      args: [`--remote-debugging-port=${String(cdpPort)}`],
    });
  } catch (error) {
    ...unchanged BrowserLaunchError wrapping...
  }
```

Add to the provider object (sibling of `newPage`):

```ts
    async runLighthouse(url: string): Promise<LighthouseRun> {
      let lighthouse;
      try {
        ({ default: lighthouse } = await import("lighthouse"));
      } catch {
        return {
          available: false,
          categories: { performance: null, accessibility: null, bestPractices: null, seo: null },
          metrics: { lcpMs: null, cls: null, tbtMs: null },
        };
      }
      const result = await lighthouse(url, {
        port: cdpPort,
        output: "json",
        logLevel: "error",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      });
      if (result === undefined) throw new Error("Lighthouse produced no result");
      const lhr = result.lhr;
      const score = (id: string): number | null => {
        const raw = lhr.categories[id]?.score;
        return typeof raw === "number" ? Math.round(raw * 100) : null;
      };
      const metric = (id: string): number | null => {
        const raw = lhr.audits[id]?.numericValue;
        return typeof raw === "number" ? raw : null;
      };
      return {
        available: true,
        categories: {
          performance: score("performance"),
          accessibility: score("accessibility"),
          bestPractices: score("best-practices"),
          seo: score("seo"),
        },
        metrics: {
          lcpMs: metric("largest-contentful-paint"),
          cls: metric("cumulative-layout-shift"),
          tbtMs: metric("total-blocking-time"),
        },
      };
    },
```

If lighthouse's `Flags` typing rejects any field, fix the flags — do NOT cast to `any`.

- [ ] **Step 8: Smoke test (real Chromium + real Lighthouse)**

Append to `tests/browser/driver-smoke.test.ts` inside the existing `describe.skipIf(!hasBrowser)` block. Serve a `/perf` route: `<html><head><title>perf</title></head><body><h1>hello</h1></body></html>`.

```ts
it("runs a real Lighthouse audit over the shared Chromium's CDP port", async () => {
  const driver = await createPlaywrightDriver();
  try {
    const run = await driver.provider.runLighthouse(perfUrl);
    expect(run.available).toBe(true);
    expect(run.categories.performance).toBeGreaterThanOrEqual(0);
    expect(run.categories.performance).toBeLessThanOrEqual(100);
    expect(run.metrics.lcpMs).toBeGreaterThan(0);
  } finally {
    await driver.teardown();
  }
}, 120_000);
```

**Known risk:** Playwright's headless Chromium is the "headless shell" build; Lighthouse over CDP against it is the approach playwright-lighthouse uses, but if the audit fails on it, report BLOCKED with the exact Lighthouse error — do not paper over it.

- [ ] **Step 9: Verify and commit**

Run: `npx vitest run tests/fake-browser.test.ts tests/browser/driver-smoke.test.ts` then `npm run format && npm run verify`.
Expected: all green, smoke test genuinely runs (not skipped).

```bash
git add -A
git commit -m "feat: add runLighthouse to the browser provider over a private CDP port"
```

---

### Task 2: the performance.lighthouse check

**Files:**
- Create: `src/checks/performance/lighthouse.ts`
- Modify: `src/engine/registry.ts` (register after `axeCheck`)
- Test: `tests/check-lighthouse.test.ts`

**Interfaces:**
- Consumes: `BrowserProvider.runLighthouse(url)`, `LighthouseRun` (Task 1); `Check`/`CheckContext`/`Finding` from `src/types.ts`; config via `ctx.config.checks["performance.lighthouse"]?.options`.

- [ ] **Step 1: Write the failing tests**

Create `tests/check-lighthouse.test.ts` following `tests/check-axe.test.ts`'s harness pattern (same `contextFor`-style helper wiring fakeBrowser + PageStore; **use `environment: "ci"`** since the check skips `local`). Cover, as separate `it` blocks:

1. Metadata: id `performance.lighthouse`, category `performance`, `requires === "browser"`, `blocking === false`, `weight === 1`, environments exactly `["ci", "production"]`.
2. Browser absent → `{ score: 100, findings: [] }`.
3. Unavailable (`lighthouse: { available: false, categories: all null, metrics: all null }`) → exactly ONE warning at baseUrl whose message mentions "lighthouse" and recommendation mentions `npm i -D lighthouse`; score 100.
4. All green (default fake = perfect run) → no findings, score 100.
5. Category advisory: performance 72, others 100, good metrics, NO config → one warning naming the category and score, message contains "Lab data"; score 95.
6. Configured budget breach: options `{ minScores: { performance: 80 } }`, performance 72 → one ERROR; score 80.
7. Configured budget met: options `{ minScores: { performance: 60 } }`, performance 72 → performance yields NO finding (configured budget replaces the default-90 advisory for that category).
8. Metric advisory: lcpMs 4000 (others good) → warning naming LCP with the ms value and the 2500 ms threshold; score 95.
9. Configured metric budget: options `{ maxMetrics: { lcpMs: 3000 } }`, lcpMs 4000 → error; score 80.
10. Null category score → no finding for it, no crash (performance: null, rest 100).
11. `runLighthouse` rejection (`throwOnLighthouse: "PROTOCOL_TIMEOUT"`) → one warning ("could not complete"), score 100.
12. `urls` option: options `{ urls: ["https://x.com/pricing"] }` with a scripted breach only on `/pricing` → findings carry `url: "https://x.com/pricing"`; both URLs audited.
13. Median runs: options `{ runs: 3 }`, scripted array `[40, 60, 50]` for performance → the finding reports 50 (median), one warning (not three).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/check-lighthouse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/checks/performance/lighthouse.ts`:

```ts
import type { LighthouseRun } from "../../browser/types.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const LAB_CAVEAT =
  "Lab data from an automated run — verify against field data (CrUX) before optimizing.";

/** Lighthouse's own green band: below this a category draws an advisory warning. */
const DEFAULT_MIN_SCORE = 90;

type CategoryKey = keyof LighthouseRun["categories"];
type MetricKey = keyof LighthouseRun["metrics"];

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  bestPractices: "Best Practices",
  seo: "SEO",
};

/** Google's "good" thresholds; TBT stands in for INP in lab data. */
const METRIC_DEFAULTS: Record<MetricKey, { max: number; label: string; format: (v: number) => string }> = {
  lcpMs: { max: 2500, label: "LCP", format: (v) => `${String(Math.round(v))} ms` },
  cls: { max: 0.1, label: "CLS", format: (v) => v.toFixed(3) },
  tbtMs: { max: 200, label: "TBT (INP lab proxy)", format: (v) => `${String(Math.round(v))} ms` },
};

interface LighthouseOptions {
  urls: string[];
  runs: number;
  minScores: Partial<Record<CategoryKey, number>>;
  maxMetrics: Partial<Record<MetricKey, number>>;
}

function lighthouseOptions(ctx: CheckContext): LighthouseOptions {
  const raw = ctx.config.checks["performance.lighthouse"]?.options;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const numRecord = <K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> => {
    const out: Partial<Record<K, number>> = {};
    if (typeof value !== "object" || value === null) return out;
    for (const key of keys) {
      const entry = num((value as Record<string, unknown>)[key]);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  };
  const urls = Array.isArray(raw?.["urls"])
    ? raw["urls"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    urls,
    runs: Math.max(1, Math.round(num(raw?.["runs"]) ?? 1)),
    minScores: numRecord(raw?.["minScores"], ["performance", "accessibility", "bestPractices", "seo"]),
    maxMetrics: numRecord(raw?.["maxMetrics"], ["lcpMs", "cls", "tbtMs"]),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Combine N runs into one: median per numeric field; available iff every run was. */
function combineRuns(runs: LighthouseRun[]): LighthouseRun {
  const first = runs[0];
  if (runs.length === 1 && first !== undefined) return first;
  const pick = (select: (run: LighthouseRun) => number | null): number | null =>
    median(runs.map(select).filter((v): v is number => v !== null));
  return {
    available: runs.every((run) => run.available),
    categories: {
      performance: pick((r) => r.categories.performance),
      accessibility: pick((r) => r.categories.accessibility),
      bestPractices: pick((r) => r.categories.bestPractices),
      seo: pick((r) => r.categories.seo),
    },
    metrics: {
      lcpMs: pick((r) => r.metrics.lcpMs),
      cls: pick((r) => r.metrics.cls),
      tbtMs: pick((r) => r.metrics.tbtMs),
    },
  };
}

export const lighthouseCheck: Check = {
  id: "performance.lighthouse",
  category: "performance",
  description:
    "Lighthouse category scores and Core Web Vitals (lab data). Advisory warnings by default; configure minScores/maxMetrics budgets to enforce as errors.",
  environments: ["ci", "production"],
  requires: "browser",
  blocking: false,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const options = lighthouseOptions(ctx);
    const targets = [ctx.baseUrl, ...options.urls.filter((url) => url !== ctx.baseUrl)];
    const findings: Finding[] = [];

    for (const url of targets) {
      let run: LighthouseRun;
      try {
        const runs: LighthouseRun[] = [];
        for (let i = 0; i < options.runs; i++) runs.push(await browser.runLighthouse(url));
        run = combineRuns(runs);
      } catch (error) {
        findings.push({
          severity: "warning",
          url,
          message: `The Lighthouse audit could not complete on ${url}: ${error instanceof Error ? error.message : String(error)}`,
          recommendation:
            "This is likely a transient page condition — re-run, or investigate if persistent.",
        });
        continue;
      }

      if (!run.available) {
        return {
          score: 100,
          findings: [
            {
              severity: "warning",
              url: ctx.baseUrl,
              message: "lighthouse is not installed, so the performance audit did not run.",
              recommendation: "Run: npm i -D lighthouse to enable the performance audit.",
            },
          ],
        };
      }

      for (const key of Object.keys(CATEGORY_LABELS) as CategoryKey[]) {
        const score = run.categories[key];
        if (score === null) continue;
        const budget = options.minScores[key];
        if (budget !== undefined) {
          if (score < budget) {
            findings.push({
              severity: "error",
              url,
              message: `Lighthouse ${CATEGORY_LABELS[key]} score ${String(score)} is below the configured budget of ${String(budget)}. ${LAB_CAVEAT}`,
              recommendation: `Investigate the Lighthouse ${CATEGORY_LABELS[key]} audit details, or adjust the minScores budget.`,
            });
          }
        } else if (score < DEFAULT_MIN_SCORE) {
          findings.push({
            severity: "warning",
            url,
            message: `Lighthouse ${CATEGORY_LABELS[key]} score is ${String(score)} (below ${String(DEFAULT_MIN_SCORE)}). ${LAB_CAVEAT}`,
            recommendation:
              "Advisory only. Set an explicit minScores budget ~10-20% above today's score and ratchet it over time.",
          });
        }
      }

      for (const key of Object.keys(METRIC_DEFAULTS) as MetricKey[]) {
        const value = run.metrics[key];
        if (value === null) continue;
        const spec = METRIC_DEFAULTS[key];
        const budget = options.maxMetrics[key];
        if (budget !== undefined) {
          if (value > budget) {
            findings.push({
              severity: "error",
              url,
              message: `${spec.label} is ${spec.format(value)}, over the configured budget of ${spec.format(budget)}. ${LAB_CAVEAT}`,
              recommendation: `Optimize ${spec.label}, or adjust the maxMetrics budget.`,
            });
          }
        } else if (value > spec.max) {
          findings.push({
            severity: "warning",
            url,
            message: `${spec.label} is ${spec.format(value)}, over the "good" threshold of ${spec.format(spec.max)}. ${LAB_CAVEAT}`,
            recommendation:
              "Advisory only. Set an explicit maxMetrics budget ~10-20% above today's value and ratchet it over time.",
          });
        }
      }

      ctx.logger.debug("Lighthouse audit", { url, categories: run.categories, metrics: run.metrics });
    }

    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    return { score: Math.max(0, 100 - 20 * errors - 5 * warnings), findings };
  },
};
```

- [ ] **Step 4: Register**

In `src/engine/registry.ts`: import `lighthouseCheck` from `../checks/performance/lighthouse.js` and register it directly after `axeCheck`.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/check-lighthouse.test.ts` — all pass; then `npm run format && npm run verify`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add performance.lighthouse check with advisory budgets"
```

---

### Task 3: README + integration test + PR

**Files:**
- Modify: `README.md`
- Test: `tests/run-review.test.ts` (append to the existing self-skipping real-Chromium describe block)

- [ ] **Step 1: Integration test**

Append to the real-browser describe block in `tests/run-review.test.ts` (mirror the axe e2e): serve a minimal static page, run a review with `performance.lighthouse` enabled and **`environment: "ci"`**, assert the report's `performance` category contains a `performance.lighthouse` entry with a numeric score 0–100 and `skipped` absent/false. Timeout 120_000. Verify it genuinely runs (not skipped) before committing.

- [ ] **Step 2: README**

In the "Browser checks (optional)" section:
- Intro sentence: move Lighthouse out of "later releases" (which then reads "and — in a later release — analytics").
- Add a table row after `accessibility.axe`:

| `performance.lighthouse` | performance | Lighthouse category scores + Core Web Vitals (LCP/CLS/TBT) over the shared Chromium. Lab data; advisory warnings by default — set `minScores`/`maxMetrics` budgets to enforce as errors. Runs in `ci`/`production` only. |

- Add an options example under the section:

```js
// site-review.config.js
export default {
  checks: {
    "performance.lighthouse": {
      options: {
        urls: ["https://example.com/pricing"], // audited in addition to the base URL
        runs: 3, // median-of-3 (default 1)
        minScores: { performance: 80 }, // breach = error (default: advisory warning below 90)
        maxMetrics: { lcpMs: 3000, cls: 0.1, tbtMs: 300 }, // breach = error
      },
    },
  },
};
```

- [ ] **Step 3: Verify, commit, PR**

Run: `npm run format && npm run verify` — green.

```bash
git add -A
git commit -m "feat: document the lighthouse check and add integration coverage"
git push -u origin feat/lighthouse
gh pr create --title "feat: performance.lighthouse check (PR 14)" --body "..."
```

PR body: summary of the seam (private CDP port, runLighthouse), the advisory-budget model, the spec deviation note, and test counts. End with the standard Claude Code attribution.

---

## Self-Review Notes

- Type names used across tasks are consistent: `LighthouseRun` (Task 1) consumed by `lighthouseCheck` (Task 2); fake knobs `lighthouse`/`throwOnLighthouse` (Task 1) used by tests (Task 2).
- Spec coverage: CDP reuse ✓ (private port), advisory budgets ✓, `numberOfRuns:1` default with median opt-in ✓, base-URL-only default + `urls` ✓, deduction scoring ✓, lab caveat ✓, graceful skip ✓, smoke test ✓.
- Deliberately omitted (YAGNI): per-category `onlyCategories` config; a public CDP endpoint; field-data (CrUX) integration.
