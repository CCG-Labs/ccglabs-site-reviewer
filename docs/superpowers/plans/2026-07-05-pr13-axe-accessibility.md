# Site Reviewer PR 13 (accessibility.axe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `accessibility.axe` — an axe-core WCAG scan run against sampled pages in a real browser — and clear two ride-along nits from PR 12's review.

**Architecture:** Per the browser-tier spec (`docs/superpowers/specs/2026-07-05-browser-tier-design.md`). axe-core needs the real Playwright `Page`, so — matching PR 12's seam discipline — axe runs INSIDE the driver: `BrowserPage` gains `runAxe(options)` returning a distilled `AxeRun` (no axe types leak past the seam). `@axe-core/playwright` is a new optional peer, dynamically imported inside the driver's `runAxe`; when it's absent the driver returns `{ available: false }` and the check surfaces one actionable warning. The check maps axe impact → severity and scores by page-clean-ratio; it is non-blocking and reports "automated scan" honestly (never "accessible").

**Tech Stack:** playwright + `@axe-core/playwright` (optional peers; devDeps here for self-testing), the existing fake-browser double, samplePages.

## Global Constraints

- Runtime `dependencies` unchanged (cheerio/commander/jiti/zod/domhandler). `@axe-core/playwright` added as an **optional peerDependency** (`peerDependenciesMeta` optional) AND a **devDependency**; added to `tsup.config.ts` external. Report schema UNCHANGED.
- No `eval` / `new Function` / `child_process` in `src/`. `@axe-core/playwright` reached ONLY via a dynamic `import("@axe-core/playwright")` inside `src/browser/playwright-driver.ts`. Coverage 90% gates untouched. TypeScript strict; no `any`. Fast test path passes with no Chromium (smoke self-skips).
- `accessibility.axe`: id `accessibility.axe`, category `accessibility`, `requires: "browser"`, `blocking: false`, weight 1, environments `["local", "ci", "production"]`.
  - Runs against `samplePages(ctx.pages.all(), ctx.baseUrl, browserSampleSize)`.
  - axe impact → severity: `critical`/`serious` → **error**; `moderate` → **warning**; `minor`/`null` → **info**. One finding per violation per page (message: rule id, impact, help text, affected-element count).
  - Options: `standard: string[]` (axe tags; default `["wcag2a", "wcag2aa"]`), `ignore: string[]` (axe rule ids to disable).
  - `@axe-core/playwright` absent (driver returns `available: false`): ONE **warning** attributed to the base URL — `axe-core is not installed — run: npm i -D @axe-core/playwright` — score 100 (not a silent pass, not a false failure).
  - Honesty: the check description states it is an automated scan catching ~30–50% of WCAG issues, not a substitute for manual testing; the report never claims the site is "accessible".
  - Scoring: page-clean-ratio (`round(100 × pages-without-error-finding / pages)`); zero pages → `{ score: 100, findings: [] }`. Non-blocking, so error-severity findings reduce score but never fail the grade.
- Ride-alongs (Task 1): (a) fix the stale `BrowserPage.onError` doc comment in `src/browser/types.ts` (it now delivers ONLY uncaught page exceptions, not console-level errors); (b) special-case `BrowserLaunchError` in `runChecks` so a browser that can't launch reports an actionable remediation finding (`Install the browser with: npx playwright install chromium`) instead of the generic "tool defect — report it as a bug".
- The browser-extras install hint (the capability-skip reason in `runner.ts`) is updated to include `@axe-core/playwright`: `requires the browser extras — run: npm i -D playwright lighthouse @axe-core/playwright && npx playwright install chromium`.
- Conventional commits. Branch: `feat/axe-accessibility` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/browser/types.ts             (ride-along a) onError doc fix; + AxeViolation, AxeRun, BrowserPage.runAxe
src/engine/runner.ts             (ride-along b) BrowserLaunchError finding; updated extras hint
src/browser/playwright-driver.ts + runAxe impl (dynamic import @axe-core/playwright)
tests/helpers/fake-browser.ts    + scripted axe runs
src/checks/accessibility/axe.ts  axeCheck
src/engine/registry.ts           register axeCheck
package.json / tsup.config.ts    @axe-core/playwright optional peer + devDep + external
README.md                        checks table row
```

---

### Task 1: Ride-alongs (doc fix, BrowserLaunchError finding, extras hint)

**Files:**

- Modify: `src/browser/types.ts`, `src/engine/runner.ts`
- Test: `tests/runner.test.ts`

**Interfaces:**

- Produces: updated `BROWSER_EXTRAS_HINT` string (now includes `@axe-core/playwright`); `runChecks` maps a thrown `BrowserLaunchError` to a remediation finding.

- [ ] **Step 1: Create branch** (already done — skip if on feat/axe-accessibility)

```bash
git checkout main && git pull && git checkout -b feat/axe-accessibility
```

- [ ] **Step 2: Fix the onError doc comment** in `src/browser/types.ts` — change the line above `onError`:

```ts
  /** register a handler for uncaught page exceptions (pageerror); console.error is intentionally not delivered */
  onError(handler: (message: string) => void): void;
```

- [ ] **Step 3: Update the extras hint + skip-reason test.** In `src/engine/runner.ts` change `BROWSER_EXTRAS_HINT` to:

```ts
const BROWSER_EXTRAS_HINT =
  "requires the browser extras — run: npm i -D playwright lighthouse @axe-core/playwright && npx playwright install chromium";
```

Update the existing `partitionChecks` browser-capability test in `tests/runner.test.ts` whose expected reason string must now include `@axe-core/playwright`.

- [ ] **Step 4: BrowserLaunchError remediation finding.** In `src/engine/runner.ts`, import the error and special-case it in the `catch` of `runChecks`:

```ts
import { BrowserLaunchError } from "../browser/types.js";
```

In the `catch (error)` block, before building the generic "Check crashed" finding:

```ts
if (error instanceof BrowserLaunchError) {
  return {
    check,
    status: "error",
    score: 0,
    findings: [
      {
        severity: "error",
        message: `Browser could not launch: ${error.message}`,
        recommendation: "Install the browser with: npx playwright install chromium",
      },
    ],
    debug,
  };
}
```

- [ ] **Step 5: Add the failing test** — append to `tests/runner.test.ts`:

```ts
describe("runChecks BrowserLaunchError handling", () => {
  const base = {
    baseUrl: "http://x.test",
    environment: "ci" as const,
    config: {
      environment: "ci" as const,
      maxPages: 200,
      failThreshold: 80,
      browserSampleSize: 5,
      requestHeaders: {},
      checks: {},
      customChecks: [],
    },
    pages: fixturePageStore([]),
    fetch: () => Promise.reject(new Error("no fetch")),
  };

  it("reports a browser launch failure with an install remediation, not a bug report", async () => {
    const { BrowserLaunchError } = await import("../src/browser/types.js");
    const check = makeCheck({
      id: "b",
      requires: "browser",
      run: () => Promise.reject(new BrowserLaunchError("Chromium missing")),
    });
    const [executed] = await runChecks([check], base);
    expect(executed?.status).toBe("error");
    expect(executed?.findings[0]?.recommendation).toContain("npx playwright install chromium");
    expect(executed?.findings[0]?.message).not.toContain("report it as a bug");
  });
});
```

(Import `fixturePageStore` at the top of the test file if not already imported.)

- [ ] **Step 6: Run tests + verify**

Run: `npx vitest run tests/runner.test.ts` — Expected: PASS (updated hint test + new launch-error test).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/browser/types.ts src/engine/runner.ts tests/runner.test.ts
git commit -m "fix: correct onError docs, actionable browser-launch finding, and axe in the extras hint"
```

---

### Task 2: BrowserPage.runAxe interface + fake-browser support

**Files:**

- Modify: `src/browser/types.ts`, `tests/helpers/fake-browser.ts`
- Test: `tests/fake-browser.test.ts`

**Interfaces:**

- Produces: `AxeViolation`, `AxeRun` types + `BrowserPage.runAxe(options?): Promise<AxeRun>` in `src/browser/types.ts`; `FakePageScript.axe?` scripting + `fakeBrowser` replaying it.

- [ ] **Step 1: Add types + method to `src/browser/types.ts`**

```ts
/** A distilled axe-core violation — no axe types leak past the driver seam. */
export interface AxeViolation {
  /** axe rule id, e.g. "color-contrast" */
  id: string;
  impact: "critical" | "serious" | "moderate" | "minor" | null;
  /** human-readable rule description */
  help: string;
  /** number of DOM elements failing this rule on the page */
  nodeCount: number;
}

export interface AxeRun {
  /** false when @axe-core/playwright could not be imported */
  available: boolean;
  violations: AxeViolation[];
}
```

Add to the `BrowserPage` interface (after `content()`):

```ts
  /** run an axe-core scan against the current page; available:false when the axe peer dep is absent */
  runAxe(options?: { standard?: string[]; ignore?: string[] }): Promise<AxeRun>;
```

- [ ] **Step 2: Add the failing test** — append to `tests/fake-browser.test.ts`:

```ts
it("replays a scripted axe run", async () => {
  const browser = fakeBrowser({
    "https://x.com/": {
      axe: {
        available: true,
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            help: "Elements must have sufficient color contrast",
            nodeCount: 3,
          },
        ],
      },
    },
  });
  const page = await browser.newPage();
  await page.goto("https://x.com/");
  const run = await page.runAxe();
  expect(run.available).toBe(true);
  expect(run.violations[0]?.id).toBe("color-contrast");
});

it("defaults runAxe to available with no violations for an unscripted page", async () => {
  const browser = fakeBrowser({});
  const page = await browser.newPage();
  await page.goto("https://x.com/");
  expect(await page.runAxe()).toEqual({ available: true, violations: [] });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/fake-browser.test.ts` — Expected: FAIL (runAxe missing).

- [ ] **Step 4: Extend `tests/helpers/fake-browser.ts`** — add `axe?: AxeRun` to `FakePageScript` (import `AxeRun` from browser types), and implement `runAxe` on the returned page reading the current script:

```ts
    runAxe() {
      return Promise.resolve(script.axe ?? { available: true, violations: [] });
    },
```

(`script` is already the closure variable set by `goto`.)

- [ ] **Step 5: Run test to verify it passes, then verify**

Run: `npx vitest run tests/fake-browser.test.ts` — Expected: PASS.
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/browser/types.ts tests/helpers/fake-browser.ts tests/fake-browser.test.ts
git commit -m "feat: add runAxe to the browser page interface and fake browser"
```

---

### Task 3: Driver runAxe implementation (@axe-core/playwright seam)

**Files:**

- Modify: `src/browser/playwright-driver.ts`, `package.json`, `tsup.config.ts`
- Test: `tests/browser/driver-smoke.test.ts`

**Interfaces:**

- Consumes: `AxeRun`/`AxeViolation` (Task 2).
- Produces: `BrowserPage.runAxe` implemented in the real driver via a dynamic `import("@axe-core/playwright")`.

- [ ] **Step 1: Install the peer + mark external**

```bash
npm install --save-dev @axe-core/playwright
```

In `package.json` `peerDependencies` add `"@axe-core/playwright": ">=4 <5"` and in `peerDependenciesMeta` add `"@axe-core/playwright": { "optional": true }`. In `tsup.config.ts` add `"@axe-core/playwright"` to `external`.

- [ ] **Step 2: Implement `runAxe` in `src/browser/playwright-driver.ts`** — inside the object returned by `newPage()` (the real Playwright `page` is in closure):

```ts
        async runAxe(options = {}) {
          let AxeBuilder;
          try {
            ({ default: AxeBuilder } = await import("@axe-core/playwright"));
          } catch {
            return { available: false, violations: [] };
          }
          let builder = new AxeBuilder({ page });
          if (options.standard !== undefined && options.standard.length > 0) {
            builder = builder.withTags(options.standard);
          }
          if (options.ignore !== undefined && options.ignore.length > 0) {
            builder = builder.disableRules(options.ignore);
          }
          const results = await builder.analyze();
          return {
            available: true,
            violations: results.violations.map((violation) => ({
              id: violation.id,
              impact: violation.impact ?? null,
              help: violation.help,
              nodeCount: violation.nodes.length,
            })),
          };
        },
```

(If TypeScript needs a `@ts-expect-error` for the optional-peer import — mirroring how the playwright import is handled — add it with the comment `@axe-core/playwright is an optional peer dependency`. Since it's a devDep after Step 1, the types resolve and the directive is likely unnecessary; follow tsc.)

- [ ] **Step 3: Add a real-Chromium smoke test** — append to `tests/browser/driver-smoke.test.ts` (inside the `describe.skipIf(!hasBrowser)` block), serving markup with a guaranteed axe violation (an image with no alt):

```ts
it("runs a real axe scan and reports violations", async () => {
  const server2 = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<html lang="en"><body><img src="/x.png"></body></html>');
  });
  await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
  const axeUrl = `http://127.0.0.1:${String((server2.address() as AddressInfo).port)}/`;
  const driver = await createPlaywrightDriver();
  try {
    const page = await driver.provider.newPage();
    await page.goto(axeUrl);
    const run = await page.runAxe({ standard: ["wcag2a"] });
    expect(run.available).toBe(true);
    expect(run.violations.some((v) => v.id === "image-alt")).toBe(true);
  } finally {
    await driver.teardown();
    await new Promise<void>((r) => server2.close(() => r()));
  }
}, 30_000);
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/browser/driver-smoke.test.ts` — Expected: PASS (Chromium + axe installed) — proves the real axe seam finds `image-alt`.
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/browser/playwright-driver.ts package.json package-lock.json tsup.config.ts tests/browser/driver-smoke.test.ts
git commit -m "feat: run axe-core through the playwright driver seam"
```

---

### Task 4: accessibility.axe check

**Files:**

- Create: `src/checks/accessibility/axe.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-axe.test.ts`

**Interfaces:**

- Consumes: `samplePages`, `BrowserPage.runAxe`, `fakeBrowser`.
- Produces: `axeCheck: Check` (id `accessibility.axe`) registered after `consoleErrorsCheck`.

- [ ] **Step 1: Write the failing test** — `tests/check-axe.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { axeCheck } from "../src/checks/accessibility/axe.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, ResolvedConfig } from "../src/types.js";
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
  environment: "ci" as Environment,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check-axe.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/accessibility/axe.ts`**

```ts
import { samplePages } from "../../browser/sample.js";
import type { AxeViolation } from "../../browser/types.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const DEFAULT_STANDARD = ["wcag2a", "wcag2aa"];

interface AxeOptions {
  standard: string[];
  ignore: string[];
}

function axeOptions(ctx: CheckContext): AxeOptions {
  const raw = ctx.config.checks["accessibility.axe"]?.options;
  const strings = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : fallback;
  return {
    standard: strings(raw?.["standard"], DEFAULT_STANDARD),
    ignore: strings(raw?.["ignore"], []),
  };
}

function severityFor(impact: AxeViolation["impact"]): Finding["severity"] {
  if (impact === "critical" || impact === "serious") return "error";
  if (impact === "moderate") return "warning";
  return "info";
}

export const axeCheck: Check = {
  id: "accessibility.axe",
  category: "accessibility",
  description:
    "Automated axe-core WCAG scan (catches ~30–50% of issues; not a substitute for manual/screen-reader testing).",
  environments: ["local", "ci", "production"],
  requires: "browser",
  blocking: false,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const targets = samplePages(ctx.pages.all(), ctx.baseUrl, ctx.config.browserSampleSize);
    if (targets.length === 0) return { score: 100, findings: [] };

    const options = axeOptions(ctx);
    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();

    for (const target of targets) {
      const page = await browser.newPage();
      try {
        await page.goto(target.url);
      } catch (error) {
        findings.push({
          severity: "warning",
          url: target.url,
          message: `Page could not be loaded for the accessibility scan: ${error instanceof Error ? error.message : String(error)}`,
          recommendation: "Re-run; if this persists the page may hang or block automated browsers.",
        });
        await page.close();
        continue;
      }
      const run = await page.runAxe({ standard: options.standard, ignore: options.ignore });
      await page.close();

      if (!run.available) {
        return {
          score: 100,
          findings: [
            {
              severity: "warning",
              url: ctx.baseUrl,
              message: "axe-core is not installed, so the accessibility scan did not run.",
              recommendation:
                "Run: npm i -D @axe-core/playwright to enable the accessibility scan.",
            },
          ],
        };
      }

      for (const violation of run.violations) {
        const severity = severityFor(violation.impact);
        findings.push({
          severity,
          url: target.url,
          message: `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help} — ${String(violation.nodeCount)} element(s).`,
          recommendation:
            "Fix the flagged elements; see the axe rule reference at https://dequeuniversity.com/rules/axe.",
        });
        if (severity === "error") pagesWithErrors.add(target.url);
      }
    }

    ctx.logger.debug("Accessibility scan", {
      pagesChecked: targets.length,
      findings: findings.length,
    });
    const cleanPages = targets.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / targets.length), findings };
  },
};
```

Register in `src/engine/registry.ts` after `consoleErrorsCheck`.

- [ ] **Step 4: Run test to verify it passes, then verify**

Run: `npx vitest run tests/check-axe.test.ts` — Expected: PASS (7 tests). Then `npx vitest run` — existing tests unaffected (axe is a new non-blocking check; header-less fixtures with no axe script return the fake's default `{available:true, violations:[]}` → no findings). Root-cause anything that fails.
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/checks/accessibility/axe.ts src/engine/registry.ts tests/check-axe.test.ts
git commit -m "feat: add accessibility.axe check mapping axe impact to findings"
```

---

### Task 5: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Real-browser integration test** — append to `tests/run-review.test.ts` (self-skips without Chromium/axe):

```ts
it("surfaces accessibility violations end-to-end when a browser is available", async () => {
  const { probeBrowserCapability } = await import("../src/browser/lazy-browser.js");
  if (!(await probeBrowserCapability())) return;
  server = await startServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<html lang="en"><head><title>t</title></head><body><img src="/x.png"></body></html>');
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const check = report.categories
    .find((c) => c.id === "accessibility")
    ?.checks.find((e) => e.id === "accessibility.axe");
  expect(check).toBeDefined();
  expect(check?.findings.some((f) => f.message.includes("image-alt"))).toBe(true);
}, 30_000);
```

- [ ] **Step 2: README** — update the browser-extras install line to include `@axe-core/playwright`:

```bash
npm i -D playwright lighthouse @axe-core/playwright
npx playwright install chromium
```

and add the checks-table row after `functionality.console-errors`:

```markdown
| `accessibility.axe` | automated axe-core WCAG scan (critical/serious → error, moderate → warning) — needs the browser extras; catches ~30–50% of issues, not a full a11y audit |
```

- [ ] **Step 3: Full verify, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.

```bash
git add -A
git commit -m "feat: document the accessibility check and add integration coverage"
git push -u origin feat/axe-accessibility
gh pr create --base main --title "feat: accessibility.axe check (PR 13)" --body "PR 13 of the roadmap — axe-core WCAG scan run through the browser rig. axe executes inside the driver seam (@axe-core/playwright is a new optional peer, dynamically imported); the check maps impact to severity (critical/serious → error, moderate → warning, minor → info), is non-blocking, samples pages, and reports honestly (automated scan, ~30–50% coverage, never claims 'accessible'). When the axe peer is absent it surfaces one actionable warning rather than passing silently. Also clears two PR 12 review nits: the onError doc comment and an actionable browser-launch finding. No report schema change; base install stays lean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

PR 14 (`performance.lighthouse`) is next and MUST introduce a real CDP mechanism (cdpEndpoint was removed in PR 12) — launch Chromium with `--remote-debugging-port` and pass the port to Lighthouse, or use a per-page CDP session. PR 15 (`operations.analytics`) uses `onRequest` interception. Ledger backlog otherwise unchanged.
