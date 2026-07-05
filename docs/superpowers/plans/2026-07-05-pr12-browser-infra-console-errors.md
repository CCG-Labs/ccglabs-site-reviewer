# Site Reviewer PR 12 (Browser Infrastructure + console-errors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the browser tier: a capability-gated, lazily-launched shared Chromium behind a `BrowserProvider` interface (one dynamic-import seam), plus the first browser check, `functionality.console-errors`.

**Architecture:** Per the approved browser-tier spec (`docs/superpowers/specs/2026-07-05-browser-tier-design.md`). Checks gain `requires?: "browser"`; the runner skips them with an install-hint when `playwright` isn't importable. When available, the engine builds a `LazyBrowser` (launches Chromium on first use, tears it down in a `finally`) and injects a `BrowserProvider` onto `CheckContext.browser`. All non-driver code depends only on the `BrowserProvider`/`BrowserPage` interfaces, so checks unit-test against a fake browser with no Chromium.

**Tech Stack:** TypeScript strict/ESM, `playwright` (optional peer dep; devDependency of this repo for self-testing), vitest, a fake-browser test double.

## Global Constraints

- Runtime dependencies unchanged (exactly `commander`, `zod`, `jiti`, `cheerio`, `domhandler`). `playwright` is added as an **optional peerDependency** (`peerDependenciesMeta.playwright.optional = true`) AND a **devDependency** of this repo. Report schema UNCHANGED (no `REPORT_VERSION` bump).
- No `eval` / `new Function` / `child_process` in `src/`. `playwright` is reached ONLY via a dynamic `import("playwright")` inside `src/browser/playwright-driver.ts` — nowhere else. Add `playwright` and `lighthouse` to `tsup.config.ts` `external` so the bundler never inlines them.
- Coverage 90% gates untouched. TypeScript strict; no `any`. The fast test path must pass with NO Chromium installed (the real-browser smoke suite self-skips when Chromium is absent).
- Skip protocol: a `requires: "browser"` check with the capability unavailable → `skipped` reason exactly `requires the browser extras — run: npm i -D playwright lighthouse && npx playwright install chromium`. Skip precedence: disabled-by-config → capability-unavailable → environment-inapplicable.
- Dep present but Chromium launch fails → affected browser checks report status `error` (not skip), remediation `npx playwright install chromium`; the run and all fetch-tier checks complete normally. Engine ALWAYS tears the browser down in `finally`.
- `functionality.console-errors`: id `functionality.console-errors`, category `functionality`, `requires: "browser"`, `blocking: true` (uncaught JS is a functional defect), weight 1, environments `["local", "ci", "production"]`.
- Page sampling: base URL + up to `browserSampleSize` (default 5) additional 2xx HTML crawled pages; config override `browserSampleSize` (0 = base only). The sampled set is deterministic (base first, then crawl order).
- Conventional commits. Branch: `feat/browser-infra`, PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/browser/types.ts             BrowserProvider, BrowserPage interfaces (NO playwright import)
src/browser/lazy-browser.ts      createLazyBrowser: capability probe + lifecycle + teardown
src/browser/playwright-driver.ts the ONLY dynamic import("playwright"); implements the interfaces
src/browser/sample.ts            samplePages(pages, baseUrl, size) — shared page-sampling helper
src/types.ts                     + Check.requires, CheckContext.browser, SiteReviewConfig.browserSampleSize
src/engine/runner.ts             + capability partition arg
src/engine/run-review.ts         build LazyBrowser, probe, inject provider, teardown in finally
src/checks/functionality/console-errors.ts   the check
src/engine/registry.ts           register consoleErrorsCheck
tests/helpers/fake-browser.ts    in-memory BrowserProvider for unit tests
tests/browser/*.test.ts          driver smoke suite (gated on Chromium present)
.github/workflows/ci.yml         + cached `npx playwright install --with-deps chromium`
tsup.config.ts                   + external: playwright, lighthouse
README.md                        browser-tier section + console-errors row
```

---

### Task 1: Browser interfaces + type extensions

**Files:**

- Create: `src/browser/types.ts`
- Modify: `src/types.ts`
- Test: `tests/browser-types.test.ts`

**Interfaces:**

- Produces: `BrowserProvider`, `BrowserPage`, `BrowserError` from `src/browser/types.ts`; `Check.requires?`, `CheckContext.browser?`, `SiteReviewConfig.browserSampleSize?`, `ResolvedConfig.browserSampleSize` in `src/types.ts` — every later task consumes these.

- [ ] **Step 1: Create branch**

```bash
git checkout main && git pull && git checkout -b feat/browser-infra
```

- [ ] **Step 2: Write `src/browser/types.ts`**

```ts
/** A failed sub-resource request observed during navigation. */
export interface FailedRequest {
  url: string;
  failure: string;
}

/**
 * A single isolated browser page. Handlers must be registered BEFORE goto().
 * Backed by a real Playwright page in production, a fake in tests — no check
 * imports playwright directly.
 */
export interface BrowserPage {
  /** register a handler for console-level errors AND uncaught page exceptions */
  onError(handler: (message: string) => void): void;
  /** register a handler for failed sub-resource requests */
  onRequestFailed(handler: (request: FailedRequest) => void): void;
  /** register a handler for every outgoing request (URL + method) */
  onRequest(handler: (url: string, method: string) => void): void;
  /** navigate; resolves with the main response status, or rejects on nav failure */
  goto(url: string): Promise<number>;
  /** the rendered HTML after scripts run */
  content(): Promise<string>;
  /** close this page and its context */
  close(): Promise<void>;
}

export interface BrowserProvider {
  /** a fresh isolated page; the engine tracks and closes it at teardown */
  newPage(): Promise<BrowserPage>;
  /** CDP endpoint for tools that drive Chromium directly (Lighthouse, later PRs) */
  cdpEndpoint(): Promise<string>;
}

/** Thrown by the provider when the browser is present-but-unlaunchable (e.g. Chromium not installed). */
export class BrowserLaunchError extends Error {}
```

- [ ] **Step 3: Extend `src/types.ts`** — add to `Check` (after `weight`):

```ts
  /** capability this check needs; absent = fetch-tier default (no browser) */
  requires?: "browser";
```

add to `CheckContext` (after `fetch`):

```ts
  /** present only when the browser capability is available; undefined otherwise */
  browser?: import("./browser/types.js").BrowserProvider;
```

add to `SiteReviewConfig`:

```ts
  browserSampleSize?: number;
```

and to `ResolvedConfig`:

```ts
browserSampleSize: number;
```

- [ ] **Step 4: Write the failing test** — `tests/browser-types.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { BrowserLaunchError } from "../src/browser/types.js";

describe("browser types", () => {
  it("exports a BrowserLaunchError distinct from Error", () => {
    const error = new BrowserLaunchError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error.message).toBe("boom");
  });
});
```

- [ ] **Step 5: Update config resolution default** — in `src/config/resolve.ts`, add `browserSampleSize` to `DEFAULTS` (value `5`) and thread it through `mergeLayer` like `maxPages` (a `!== undefined` guarded scalar). Add a resolve test asserting the default is 5 and that a layer override wins.

- [ ] **Step 6: Run tests + verify**

Run: `npx vitest run tests/browser-types.test.ts tests/config-resolve.test.ts` — Expected: PASS.
Run: `npm run format && npm run verify` — Expected: green (types-only additions compile; `CheckContext.browser` optional so all existing check-context literals still satisfy it).

- [ ] **Step 7: Commit**

```bash
git add src/browser/types.ts src/types.ts src/config/resolve.ts tests/browser-types.test.ts tests/config-resolve.test.ts
git commit -m "feat: add browser provider interfaces and capability/sample-size types"
```

---

### Task 2: Page-sampling helper

**Files:**

- Create: `src/browser/sample.ts`
- Test: `tests/browser-sample.test.ts`

**Interfaces:**

- Consumes: `CrawledPage` from `src/types.ts`.
- Produces: `samplePages(pages: CrawledPage[], baseUrl: string, size: number): CrawledPage[]` — the base page (if crawled) first, then up to `size` more 2xx HTML pages in crawl order, deduped by URL. Total length ≤ `size + 1`.

- [ ] **Step 1: Write the failing test** — `tests/browser-sample.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { samplePages } from "../src/browser/sample.js";
import { fixturePage } from "./helpers/page-store.js";

const page = (url: string, extra = {}) => fixturePage({ url, ...extra });

describe("samplePages", () => {
  it("puts the base page first, then up to size more in order", () => {
    const pages = [page("https://x.com/a"), page("https://x.com/"), page("https://x.com/b")];
    const sampled = samplePages(pages, "https://x.com/", 1);
    expect(sampled.map((p) => new URL(p.url).pathname)).toEqual(["/", "/a"]);
  });

  it("size 0 yields only the base page", () => {
    const pages = [page("https://x.com/"), page("https://x.com/a")];
    expect(samplePages(pages, "https://x.com/", 0).map((p) => p.url)).toEqual(["https://x.com/"]);
  });

  it("excludes non-2xx and non-HTML pages", () => {
    const pages = [
      page("https://x.com/"),
      page("https://x.com/gone", { status: 404, ok: false }),
      page("https://x.com/data.json", { headers: { "content-type": "application/json" } }),
      page("https://x.com/ok"),
    ];
    expect(samplePages(pages, "https://x.com/", 10).map((p) => new URL(p.url).pathname)).toEqual([
      "/",
      "/ok",
    ]);
  });

  it("still returns extras when the base URL was not crawled", () => {
    const pages = [page("https://x.com/a"), page("https://x.com/b")];
    expect(samplePages(pages, "https://x.com/", 1).map((p) => new URL(p.url).pathname)).toEqual([
      "/a",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/browser-sample.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/browser/sample.ts`**

```ts
import { normalizePageUrl } from "../crawl/url.js";
import type { CrawledPage } from "../types.js";

const isSampleable = (page: CrawledPage): boolean =>
  page.status >= 200 &&
  page.status < 300 &&
  (page.headers["content-type"] ?? "").includes("text/html");

/**
 * Choose which pages the browser checks visit: the base page first (if it was
 * crawled and sampleable), then up to `size` more sampleable pages in crawl
 * order. Deduped by URL; total length ≤ size + 1.
 */
export function samplePages(pages: CrawledPage[], baseUrl: string, size: number): CrawledPage[] {
  const base = normalizePageUrl(baseUrl);
  const sampleable = pages.filter(isSampleable);
  const result: CrawledPage[] = [];
  const seen = new Set<string>();

  const basePage = sampleable.find((page) => page.url === base);
  if (basePage !== undefined) {
    result.push(basePage);
    seen.add(basePage.url);
  }
  for (const page of sampleable) {
    if (result.length >= size + 1) break;
    if (seen.has(page.url)) continue;
    result.push(page);
    seen.add(page.url);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes, then verify**

Run: `npx vitest run tests/browser-sample.test.ts` — Expected: PASS (4 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sample.ts tests/browser-sample.test.ts
git commit -m "feat: add browser page-sampling helper"
```

---

### Task 3: Fake browser test double

**Files:**

- Create: `tests/helpers/fake-browser.ts`
- Test: `tests/fake-browser.test.ts`

**Interfaces:**

- Consumes: `BrowserProvider`, `BrowserPage`, `FailedRequest` from `src/browser/types.ts`.
- Produces: `fakeBrowser(scripted: Record<string, FakePageScript>): BrowserProvider` and `interface FakePageScript { status?: number; errors?: string[]; failedRequests?: FailedRequest[]; requests?: Array<{ url: string; method: string }>; content?: string }` — later check tests import these.

- [ ] **Step 1: Write the failing test** — `tests/fake-browser.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fakeBrowser } from "./helpers/fake-browser.js";

describe("fakeBrowser", () => {
  it("replays scripted errors and status for a page", async () => {
    const browser = fakeBrowser({
      "https://x.com/": { status: 200, errors: ["Uncaught TypeError: x is not a function"] },
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.onError((message) => errors.push(message));
    const status = await page.goto("https://x.com/");
    await page.close();
    expect(status).toBe(200);
    expect(errors).toEqual(["Uncaught TypeError: x is not a function"]);
  });

  it("replays failed requests and captures outgoing requests", async () => {
    const browser = fakeBrowser({
      "https://x.com/": {
        failedRequests: [{ url: "https://x.com/app.js", failure: "net::ERR_ABORTED" }],
        requests: [{ url: "https://ga.example/collect", method: "POST" }],
      },
    });
    const page = await browser.newPage();
    const failed: string[] = [];
    const seen: string[] = [];
    page.onRequestFailed((request) => failed.push(request.url));
    page.onRequest((url) => seen.push(url));
    await page.goto("https://x.com/");
    expect(failed).toEqual(["https://x.com/app.js"]);
    expect(seen).toContain("https://ga.example/collect");
  });

  it("defaults to status 200 and no events for an unscripted URL", async () => {
    const browser = fakeBrowser({});
    const page = await browser.newPage();
    const errors: string[] = [];
    page.onError((message) => errors.push(message));
    expect(await page.goto("https://x.com/unknown")).toBe(200);
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fake-browser.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `tests/helpers/fake-browser.ts`**

```ts
import type { BrowserPage, BrowserProvider, FailedRequest } from "../../src/browser/types.js";

export interface FakePageScript {
  status?: number;
  errors?: string[];
  failedRequests?: FailedRequest[];
  requests?: Array<{ url: string; method: string }>;
  content?: string;
}

/** An in-memory BrowserProvider that replays scripted per-URL events. No Chromium. */
export function fakeBrowser(scripted: Record<string, FakePageScript>): BrowserProvider {
  return {
    newPage(): Promise<BrowserPage> {
      const errorHandlers: Array<(message: string) => void> = [];
      const failedHandlers: Array<(request: FailedRequest) => void> = [];
      const requestHandlers: Array<(url: string, method: string) => void> = [];
      let script: FakePageScript = {};
      const page: BrowserPage = {
        onError(handler) {
          errorHandlers.push(handler);
        },
        onRequestFailed(handler) {
          failedHandlers.push(handler);
        },
        onRequest(handler) {
          requestHandlers.push(handler);
        },
        goto(url) {
          script = scripted[url] ?? {};
          for (const request of script.requests ?? [])
            for (const handler of requestHandlers) handler(request.url, request.method);
          for (const message of script.errors ?? [])
            for (const handler of errorHandlers) handler(message);
          for (const failure of script.failedRequests ?? [])
            for (const handler of failedHandlers) handler(failure);
          return Promise.resolve(script.status ?? 200);
        },
        content() {
          return Promise.resolve(script.content ?? "<html></html>");
        },
        close() {
          return Promise.resolve();
        },
      };
      return Promise.resolve(page);
    },
    cdpEndpoint() {
      return Promise.resolve("ws://fake-cdp");
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes, then verify**

Run: `npx vitest run tests/fake-browser.test.ts` — Expected: PASS (3 tests).
Run: `npm run format && npm run verify` — Expected: green. Note: `tests/helpers/**` is coverage-exempt (only `src/**` is included).

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/fake-browser.ts tests/fake-browser.test.ts
git commit -m "test: add in-memory fake browser provider for check unit tests"
```

---

### Task 4: LazyBrowser (capability probe + lifecycle)

**Files:**

- Create: `src/browser/lazy-browser.ts`
- Test: `tests/lazy-browser.test.ts`

**Interfaces:**

- Consumes: `BrowserProvider`, `BrowserPage`, `BrowserLaunchError` from `src/browser/types.ts`.
- Produces:
  - `probeBrowserCapability(importer?: () => Promise<unknown>): Promise<boolean>` — true iff the importer resolves.
  - `createLazyBrowser(driverFactory: () => Promise<{ provider: BrowserProvider; teardown: () => Promise<void> }>): { provider: BrowserProvider; teardown: () => Promise<void> }` — wraps a driver factory so Chromium launches on first `newPage()`/`cdpEndpoint()` and teardown is idempotent/no-op if never launched.

- [ ] **Step 1: Write the failing test** — `tests/lazy-browser.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { createLazyBrowser, probeBrowserCapability } from "../src/browser/lazy-browser.js";
import { fakeBrowser } from "./helpers/fake-browser.js";

describe("probeBrowserCapability", () => {
  it("is true when the importer resolves", async () => {
    expect(await probeBrowserCapability(() => Promise.resolve({}))).toBe(true);
  });
  it("is false when the importer rejects (dep not installed)", async () => {
    expect(
      await probeBrowserCapability(() => Promise.reject(new Error("Cannot find module"))),
    ).toBe(false);
  });
});

describe("createLazyBrowser", () => {
  it("does not build the driver until the first newPage", async () => {
    const factory = vi.fn(() =>
      Promise.resolve({ provider: fakeBrowser({}), teardown: () => Promise.resolve() }),
    );
    const lazy = createLazyBrowser(factory);
    expect(factory).not.toHaveBeenCalled();
    await lazy.provider.newPage();
    expect(factory).toHaveBeenCalledTimes(1);
    await lazy.provider.newPage();
    expect(factory).toHaveBeenCalledTimes(1); // memoized
  });

  it("teardown is a no-op when the browser never launched", async () => {
    const teardown = vi.fn(() => Promise.resolve());
    const factory = vi.fn(() => Promise.resolve({ provider: fakeBrowser({}), teardown }));
    const lazy = createLazyBrowser(factory);
    await lazy.teardown();
    expect(teardown).not.toHaveBeenCalled();
  });

  it("teardown closes the driver once it has launched", async () => {
    const teardown = vi.fn(() => Promise.resolve());
    const lazy = createLazyBrowser(() => Promise.resolve({ provider: fakeBrowser({}), teardown }));
    await lazy.provider.newPage();
    await lazy.teardown();
    expect(teardown).toHaveBeenCalledTimes(1);
    await lazy.teardown(); // idempotent
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lazy-browser.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/browser/lazy-browser.ts`**

```ts
import type { BrowserPage, BrowserProvider } from "./types.js";

/** True iff the browser peer dependency can be imported. */
export async function probeBrowserCapability(
  importer: () => Promise<unknown> = () => import("playwright"),
): Promise<boolean> {
  try {
    await importer();
    return true;
  } catch {
    return false;
  }
}

interface Driver {
  provider: BrowserProvider;
  teardown: () => Promise<void>;
}

/**
 * Wrap a driver factory so the real browser launches only on first use and is
 * torn down at most once. If no page is ever requested, no browser launches and
 * teardown is a no-op.
 */
export function createLazyBrowser(driverFactory: () => Promise<Driver>): {
  provider: BrowserProvider;
  teardown: () => Promise<void>;
} {
  let driver: Promise<Driver> | undefined;
  const ensure = (): Promise<Driver> => {
    driver ??= driverFactory();
    return driver;
  };
  return {
    provider: {
      async newPage(): Promise<BrowserPage> {
        return (await ensure()).provider.newPage();
      },
      async cdpEndpoint(): Promise<string> {
        return (await ensure()).provider.cdpEndpoint();
      },
    },
    async teardown(): Promise<void> {
      if (driver === undefined) return;
      const resolved = await driver;
      driver = undefined;
      await resolved.teardown();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes, then verify**

Run: `npx vitest run tests/lazy-browser.test.ts` — Expected: PASS (5 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/browser/lazy-browser.ts tests/lazy-browser.test.ts
git commit -m "feat: add lazy browser lifecycle and capability probe"
```

---

### Task 5: Capability partition in the runner

**Files:**

- Modify: `src/engine/runner.ts`
- Test: `tests/runner.test.ts`

**Interfaces:**

- Consumes: `Check`, `CheckOverride`, `Environment` from `src/types.ts`.
- Produces: `partitionChecks(checks, environment, overrides, browserAvailable)` — new 4th param (default `true` for back-compat with existing call sites/tests until run-review passes it). Adds the capability-skip branch with the exact reason string.

- [ ] **Step 1: Add the failing test** — append to `tests/runner.test.ts`:

```ts
describe("partitionChecks browser capability", () => {
  const browserCheck = makeCheck({ id: "b", requires: "browser" });
  const fetchCheck = makeCheck({ id: "f" });

  it("skips browser checks with an install hint when the capability is unavailable", () => {
    const { toRun, skipped } = partitionChecks([browserCheck, fetchCheck], "ci", {}, false);
    expect(toRun.map((c) => c.id)).toEqual(["f"]);
    expect(skipped).toEqual([
      {
        id: "b",
        reason:
          "requires the browser extras — run: npm i -D playwright lighthouse && npx playwright install chromium",
      },
    ]);
  });

  it("runs browser checks when the capability is available", () => {
    const { toRun } = partitionChecks([browserCheck], "ci", {}, true);
    expect(toRun.map((c) => c.id)).toEqual(["b"]);
  });

  it("config-disable wins over the capability skip", () => {
    const { skipped } = partitionChecks([browserCheck], "ci", { b: { enabled: false } }, false);
    expect(skipped[0]?.reason).toBe("disabled by config");
  });
});
```

(The existing `makeCheck` helper in this file spreads overrides, so `requires: "browser"` passes through. If `makeCheck`'s type doesn't include `requires`, it does via `Partial<Check>`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runner.test.ts` — Expected: FAIL (arity / reason mismatch).

- [ ] **Step 3: Update `partitionChecks` in `src/engine/runner.ts`**

```ts
const BROWSER_EXTRAS_HINT =
  "requires the browser extras — run: npm i -D playwright lighthouse && npx playwright install chromium";

export function partitionChecks(
  checks: Check[],
  environment: Environment,
  overrides: Record<string, CheckOverride>,
  browserAvailable = true,
): { toRun: Check[]; skipped: Array<{ id: string; reason: string }> } {
  const toRun: Check[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const check of checks) {
    if (overrides[check.id]?.enabled === false) {
      skipped.push({ id: check.id, reason: "disabled by config" });
    } else if (check.requires === "browser" && !browserAvailable) {
      skipped.push({ id: check.id, reason: BROWSER_EXTRAS_HINT });
    } else if (!check.environments.includes(environment)) {
      skipped.push({ id: check.id, reason: `not applicable in environment "${environment}"` });
    } else {
      toRun.push(check);
    }
  }
  return { toRun, skipped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runner.test.ts` — Expected: PASS (existing + 3 new; existing calls use the default 4th arg).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/runner.ts tests/runner.test.ts
git commit -m "feat: skip browser-capability checks with an install hint"
```

---

### Task 6: Wire the browser into run-review

**Files:**

- Modify: `src/engine/run-review.ts`
- Test: `tests/run-review.test.ts`

**Interfaces:**

- Consumes: `probeBrowserCapability`, `createLazyBrowser` (Task 4); `createPlaywrightDriver` (Task 7 — imported but only invoked when the capability probe passed, so tests without Chromium never reach it); `partitionChecks` 4th arg (Task 5).
- Produces: `runReview` now probes the browser capability, passes `browserAvailable` to `partitionChecks`, injects the provider onto the checks' base context, and tears the browser down in a `finally`.

- [ ] **Step 1: Add the failing test** — append to `tests/run-review.test.ts`:

```ts
it("skips browser checks (with the extras hint) when playwright is not injected", async () => {
  server = await startServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
  });
  // In the fast test path, the real capability probe finds playwright as a
  // devDependency — so force the unavailable path via a test-only override.
  const report = await runReview({ url: server.url, environment: "ci", browserCapability: false });
  expect(report.skipped.some((skip) => skip.id === "functionality.console-errors")).toBe(true);
});
```

To make this testable without depending on whether Chromium is installed, add an internal option `browserCapability?: boolean` to `RunReviewOptions` that, when set, bypasses the probe. Document it as test-only.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run-review.test.ts` — Expected: FAIL (`browserCapability` unknown / console-errors not registered yet — Task 7 registers it; if it fails only because the check isn't registered, that's expected until Task 7. Sequence note: implement Steps 3–4 here, then this test passes after Task 7 registers the check. If executing strictly in order, assert instead on the wiring via a unit check and revisit; simplest: do Task 7 registration import in the same PR and run this test at Task 7's end.)

- [ ] **Step 3: Edit `src/engine/run-review.ts`**

Add imports:

```ts
import { createLazyBrowser, probeBrowserCapability } from "../browser/lazy-browser.js";
import { createPlaywrightDriver } from "../browser/playwright-driver.js";
```

Add to `RunReviewOptions`:

```ts
  /** test-only: bypass the capability probe */
  browserCapability?: boolean;
```

In `runReview`, after the crawl and before `partitionChecks`/`runChecks`:

```ts
const browserAvailable = options.browserCapability ?? (await probeBrowserCapability());
const lazyBrowser = browserAvailable
  ? createLazyBrowser(() => createPlaywrightDriver())
  : undefined;
```

Pass `browserAvailable` as the 4th arg to `partitionChecks`. Add `browser: lazyBrowser?.provider` to the base context object handed to `runChecks`. Wrap the `runChecks` call in `try { … } finally { await lazyBrowser?.teardown(); }`.

- [ ] **Step 4: Verify** (after Task 7 registers the check)

Run: `npx vitest run tests/run-review.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** (combine with Task 7 if executed together, or commit the wiring alone)

```bash
git add src/engine/run-review.ts tests/run-review.test.ts
git commit -m "feat: probe browser capability and inject the provider into the review run"
```

---

### Task 7: playwright-driver + functionality.console-errors + registry + tsup external

**Files:**

- Create: `src/browser/playwright-driver.ts`, `src/checks/functionality/console-errors.ts`
- Modify: `src/engine/registry.ts`, `tsup.config.ts`, `package.json`
- Test: `tests/check-console-errors.test.ts`, `tests/browser/driver-smoke.test.ts`

**Interfaces:**

- Consumes: `BrowserProvider`/`BrowserPage`/`BrowserLaunchError` (Task 1), `samplePages` (Task 2), `fakeBrowser` (Task 3), `pageDom`/`ctx.pages`.
- Produces: `createPlaywrightDriver()` (the sole `import("playwright")`); `consoleErrorsCheck: Check` registered in `builtinChecks`.

- [ ] **Step 1: Add `playwright` as devDependency + optional peer, mark externals**

```bash
npm install --save-dev playwright
npx playwright install chromium
```

In `package.json` add:

```json
"peerDependencies": { "playwright": "*", "lighthouse": "*" },
"peerDependenciesMeta": { "playwright": { "optional": true }, "lighthouse": { "optional": true } }
```

In `tsup.config.ts` add `external: ["playwright", "lighthouse"]` to the config object.

- [ ] **Step 2: Write `src/browser/playwright-driver.ts`**

```ts
import {
  BrowserLaunchError,
  type BrowserPage,
  type BrowserProvider,
  type FailedRequest,
} from "./types.js";

const NAV_TIMEOUT_MS = 30_000;

/**
 * The single seam that imports playwright. Launches one headless Chromium and
 * returns a provider that hands out isolated pages plus a teardown closure.
 */
export async function createPlaywrightDriver(): Promise<{
  provider: BrowserProvider;
  teardown: () => Promise<void>;
}> {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new BrowserLaunchError(
      `playwright import failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new BrowserLaunchError(
      `Chromium failed to launch — run "npx playwright install chromium": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const provider: BrowserProvider = {
    async newPage(): Promise<BrowserPage> {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      return {
        onError(handler) {
          page.on("pageerror", (error) => {
            handler(error.message);
          });
          page.on("console", (message) => {
            if (message.type() === "error") handler(message.text());
          });
        },
        onRequestFailed(handler) {
          page.on("requestfailed", (request) => {
            const failure: FailedRequest = {
              url: request.url(),
              failure: request.failure()?.errorText ?? "unknown",
            };
            handler(failure);
          });
        },
        onRequest(handler) {
          page.on("request", (request) => {
            handler(request.url(), request.method());
          });
        },
        async goto(url) {
          const response = await page.goto(url, { waitUntil: "load" });
          return response?.status() ?? 0;
        },
        async content() {
          return page.content();
        },
        async close() {
          await context.close();
        },
      };
    },
    async cdpEndpoint(): Promise<string> {
      // Chromium exposes a CDP ws endpoint; used by Lighthouse in a later PR.
      return browser.wsEndpoint();
    },
  };

  return {
    provider,
    teardown: async () => {
      await browser.close();
    },
  };
}
```

(Note: `browser.wsEndpoint()` exists on the Playwright `Browser` for chromium; if the installed Playwright version types it differently, adapt to the CDP-session accessor — Lighthouse wiring is PR 14, so a passing smoke test that the endpoint is a non-empty string is sufficient here.)

- [ ] **Step 3: Write `src/checks/functionality/console-errors.ts`**

```ts
import { samplePages } from "../../browser/sample.js";
import type { Check, Finding } from "../../types.js";

interface ConsoleErrorsOptions {
  ignore: string[];
}

export const consoleErrorsCheck: Check = {
  id: "functionality.console-errors",
  category: "functionality",
  description: "Pages load without uncaught JavaScript errors or failed resource requests.",
  environments: ["local", "ci", "production"],
  requires: "browser",
  blocking: true,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const rawIgnore = ctx.config.checks["functionality.console-errors"]?.options?.["ignore"];
    const options: ConsoleErrorsOptions = {
      ignore: Array.isArray(rawIgnore)
        ? rawIgnore.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
    const ignored = (text: string): boolean => options.ignore.some((p) => text.includes(p));

    const targets = samplePages(ctx.pages.all(), ctx.baseUrl, ctx.config.browserSampleSize);
    if (targets.length === 0) return { score: 100, findings: [] };

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();

    for (const target of targets) {
      const page = await browser.newPage();
      const errors: string[] = [];
      const failed: string[] = [];
      page.onError((message) => {
        if (!ignored(message)) errors.push(message);
      });
      page.onRequestFailed((request) => {
        if (!ignored(request.url)) failed.push(request.url);
      });
      try {
        await page.goto(target.url);
      } catch (error) {
        findings.push({
          severity: "warning",
          url: target.url,
          message: `Page could not be loaded in a browser: ${error instanceof Error ? error.message : String(error)}`,
          recommendation: "Re-run; if this persists the page may hang or block automated browsers.",
        });
        await page.close();
        continue;
      }
      await page.close();

      if (errors.length > 0) {
        findings.push({
          severity: "error",
          url: target.url,
          message: `${String(errors.length)} JavaScript error(s): ${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? " | …" : ""}`,
          recommendation:
            "Fix the uncaught errors — they can silently break navigation, forms, or analytics.",
        });
        pagesWithErrors.add(target.url);
      }
      if (failed.length > 0) {
        findings.push({
          severity: "warning",
          url: target.url,
          message: `${String(failed.length)} failed resource request(s): ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", …" : ""}`,
          recommendation:
            "Fix or remove the broken requests (404/blocked assets, mixed content, dead APIs).",
        });
      }
    }

    ctx.logger.debug("Console-error scan", {
      pagesChecked: targets.length,
      findings: findings.length,
    });
    const cleanPages = targets.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / targets.length), findings };
  },
};
```

Register in `src/engine/registry.ts` after `errorPagesCheck` (keep functionality checks adjacent).

- [ ] **Step 4: Write the check unit test** — `tests/check-console-errors.test.ts` (fake browser, no Chromium)

```ts
import { describe, expect, it } from "vitest";
import { consoleErrorsCheck } from "../src/checks/functionality/console-errors.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, ResolvedConfig } from "../src/types.js";
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
  environment: "ci" as Environment,
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

  it("returns 100 when the browser provider is absent", async () => {
    const ctx = contextFor([{ url: "https://x.com/" }], {});
    const outcome = await consoleErrorsCheck.run({ ...ctx, browser: undefined });
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
```

- [ ] **Step 5: Write the driver smoke test** — `tests/browser/driver-smoke.test.ts` (real Chromium, self-skipping)

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { probeBrowserCapability } from "../../src/browser/lazy-browser.js";
import { createPlaywrightDriver } from "../../src/browser/playwright-driver.js";

const hasBrowser = await probeBrowserCapability();

describe.skipIf(!hasBrowser)("playwright driver (real Chromium)", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<html><body><script>throw new Error("boom-smoke");</script></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("captures a real uncaught page error", async () => {
    const driver = await createPlaywrightDriver();
    try {
      const page = await driver.provider.newPage();
      const errors: string[] = [];
      page.onError((message) => errors.push(message));
      const status = await page.goto(url);
      await page.close();
      expect(status).toBe(200);
      expect(errors.join(" ")).toContain("boom-smoke");
      expect(await driver.provider.cdpEndpoint()).not.toBe("");
    } finally {
      await driver.teardown();
    }
  }, 30_000);
});
```

- [ ] **Step 6: Full verification**

Run: `npx vitest run tests/check-console-errors.test.ts tests/run-review.test.ts` — Expected: PASS (Task 6's test now passes with the check registered).
Run: `npx vitest run tests/browser/driver-smoke.test.ts` — Expected: PASS (Chromium was installed in Step 1) — proves the real driver captures a real page error.
Run: `npm run format && npm run verify` — Expected: green including the smoke test.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add playwright driver and functionality.console-errors check"
```

---

### Task 8: CI, README, PR

**Files:**

- Modify: `.github/workflows/ci.yml`, `README.md`
- Test (modify): `tests/run-review.test.ts` (one real-browser integration case, self-skipping)

- [ ] **Step 1: CI Chromium install (cached)** — in `.github/workflows/ci.yml`, in the `verify` job after `npm ci` and before `npm run verify`, add a cached Playwright browser install:

```yaml
- name: Cache Playwright browsers
  uses: actions/cache@d4323d4df104b026a6aa633fdb11d772146be0bf # v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
- name: Install Chromium
  run: npx playwright install --with-deps chromium
```

(Look up the current `actions/cache` SHA with `gh api repos/actions/cache/git/refs/tags/v4 --jq .object.sha` and pin it, matching the repo's SHA-pinning convention.)

- [ ] **Step 2: Real-browser integration test** — append to `tests/run-review.test.ts` (self-skips without Chromium):

```ts
it("surfaces console errors end-to-end when a browser is available", async () => {
  const { probeBrowserCapability } = await import("../src/browser/lazy-browser.js");
  if (!(await probeBrowserCapability())) return; // skip on a lean checkout
  server = await startServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<html lang="en"><head><title>t</title></head><body><script>undefinedFn()</script></body></html>',
    );
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const check = report.categories
    .find((c) => c.id === "functionality")
    ?.checks.find((e) => e.id === "functionality.console-errors");
  expect(check?.status).toBe("fail");
  expect(check?.findings.some((f) => f.severity === "error")).toBe(true);
}, 30_000);
```

- [ ] **Step 3: README** — add a "Browser checks (optional)" section and a checks-table row:

````markdown
## Browser checks (optional)

Checks that need a real browser (`functionality.console-errors`, and — in later
releases — accessibility, Lighthouse, and analytics) are **off by default** to
keep the base install lean. Enable them by installing the browser extras:

```bash
npm i -D playwright lighthouse
npx playwright install chromium
```

Without them, these checks appear in the report's `skipped` list with the exact
command to enable them. Configure how many crawled pages they sample with
`browserSampleSize` (default 5; 0 = base URL only).
````

Add the table row after `functionality.error-pages`:

```markdown
| `functionality.console-errors` | pages load with no uncaught JS errors (error) or failed resource requests (warning) — needs the browser extras |
```

- [ ] **Step 4: Full verify, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.

```bash
git add -A
git commit -m "ci: install Chromium for browser checks; document the browser tier"
git push -u origin feat/browser-infra
gh pr create --base main --title "feat: browser infrastructure + console-errors (PR 12)" --body "PR 12 of the roadmap — opens the browser tier per docs/superpowers/specs/2026-07-05-browser-tier-design.md. Capability-gated shared Chromium behind a BrowserProvider interface (single dynamic-import seam in playwright-driver.ts), lazy launch + guaranteed teardown, install-hint skip when the peer dep is absent, and the first browser check (functionality.console-errors). playwright/lighthouse are optional peer dependencies (devDependencies here for self-testing). Checks unit-test against an in-memory fake browser; a self-skipping smoke suite exercises real Chromium; CI installs Chromium (cached). No report schema change; base install stays lean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

PR 13 (`accessibility.axe`) reuses this rig — a new `requires: "browser"` check plus the `@axe-core/playwright` optional peer, running axe against `samplePages`. PR 14 (`performance.lighthouse`) uses `cdpEndpoint()`. PR 15 (`operations.analytics`) uses `onRequest` interception. Ledger backlog unchanged.
