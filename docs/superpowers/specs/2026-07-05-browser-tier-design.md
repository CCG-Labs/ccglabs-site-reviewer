# CCG Labs Site Reviewer — Browser Tier Design

**Date:** 2026-07-05
**Status:** Draft — pending Brian's review
**Covers:** Roadmap PRs 12–15 (the browser-tier checks) and the shared browser infrastructure they depend on.
**Builds on:** `docs/superpowers/specs/2026-07-03-site-reviewer-design.md` (core engine, check-registry, environment partitioning, skip protocol).

## Context

The fetch tier is complete: 15 checks reachable with HTTP + HTML parsing alone. The remaining roadmap checks need a real browser:

- `functionality.console-errors` — JS exceptions + failed requests per page (Playwright).
- `accessibility.axe` — WCAG scan via axe-core injected into a real DOM (`@axe-core/playwright`).
- `performance.lighthouse` — Core Web Vitals + Lighthouse category scores (Lighthouse driving Chromium).
- `operations.analytics` — analytics snippet present + correct property ID + events fire (Playwright request interception).

These require `playwright` (~300MB with Chromium) and `lighthouse`. The core tool must stay lean, so this design adds a browser capability that is present only when the user opts in.

## Decisions made with Brian

- **Distribution: in-package checks, `playwright`/`lighthouse` as optional peer dependencies.** The browser checks ship inside `@ccglabs/site-reviewer`; their heavy imports are deferred (dynamic `import()`), and `playwright`/`lighthouse` are declared in `peerDependencies` with `peerDependenciesMeta: { playwright: { optional: true }, lighthouse: { optional: true } }`. `npm i @ccglabs/site-reviewer` stays lean; browser checks activate after `npm i -D playwright lighthouse && npx playwright install chromium`. (Rejected: `optionalDependencies`, which auto-pulls Chromium for everyone; a separate companion package, which adds two-package release machinery we don't need.)
- **Graceful skip via the existing mechanism.** A browser check whose peer dep is absent is reported as `skipped` with a reason — the same report field environment-inapplicable checks already use. No new skip surface.
- **One browser per run, shared.** Chromium launches once, lazily, on the first browser check that needs it, and is torn down after all checks finish. Pages are per-check for isolation; the process is shared for cost. If no browser check runs, Chromium never launches.
- **Lighthouse reuses Playwright's Chromium** over CDP rather than launching a second Chrome (one browser process; drops the `chrome-launcher` dep).
- **One whole-tier spec (this doc), PR-by-PR implementation plans.** The lifecycle/capability decisions are shared across all four checks, so they belong in one design; each PR still gets its own just-in-time plan.
- **Lighthouse budgets are advisory by default, configurable to hard limits.** CWV/category findings default to `warning` (never fail a merge on first adoption); users set explicit thresholds in config to promote them to `error`. Matches the research guidance: measure first, set budgets ~10–20% above current, ratchet over time.

## Architecture

### Capability gating (mirrors environment partitioning)

The `Check` interface gains one optional field:

```ts
export interface Check {
  // …existing fields…
  /** capability this check needs; absent = no special capability (fetch-tier default) */
  requires?: "browser";
}
```

The runner already partitions checks by environment before executing. It gains a second partition pass: resolve capability availability **once per run** (is `playwright` dynamically importable?). A check with `requires: "browser"` when the browser capability is unavailable is moved to `skipped` with reason:

> `requires the browser extras — run: npm i -D playwright lighthouse && npx playwright install chromium`

This happens before `run()` is ever called, so a browser check's `run()` is guaranteed a working browser handle. Skip-precedence order: disabled-by-config → capability-unavailable → environment-inapplicable (config disable still wins; capability before environment so the "install the extras" hint is shown even in an applicable environment).

### Browser provider on the context

`CheckContext` gains an optional provider, present only when the browser capability is available:

```ts
export interface BrowserPage {
  /** navigate; returns the main response status (or throws on nav failure) */
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" },
  ): Promise<number>;
  /** subscribe to console/page errors and failed requests before navigation */
  onConsoleError(handler: (message: string) => void): void;
  onRequestFailed(handler: (url: string, failure: string) => void): void;
  onRequest(handler: (url: string, method: string) => void): void;
  /** run axe or read the DOM — returns the underlying Playwright Page for check-specific work */
  raw(): unknown; // typed as import("playwright").Page inside browser checks via a cast helper
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  /** a fresh, isolated page (own context); the engine tracks and closes it at teardown */
  newPage(): Promise<BrowserPage>;
  /** CDP endpoint for tools that drive Chromium directly (Lighthouse) */
  cdpEndpoint(): Promise<string>;
}

export interface CheckContext {
  // …existing fields…
  /** present only when the browser capability is available; undefined otherwise */
  browser?: BrowserProvider;
}
```

Because capability gating guarantees `ctx.browser` is present whenever a `requires: "browser"` check runs, each browser check begins with one defensive narrowing line — `const browser = ctx.browser; if (browser === undefined) return { score: 100, findings: [] };` — which satisfies TypeScript's optional type and is unreachable in practice (the gate never lets a browser check run without it). This keeps `CheckContext` a single flat type (no browser-check-specific subtype) and the narrowing is trivially testable. Fetch-tier checks simply never read `browser`.

The provider is backed by `src/browser/playwright-driver.ts`, the ONLY module that imports `playwright` (dynamically). Everything else depends on the `BrowserProvider`/`BrowserPage` interfaces, so the heavy dep has exactly one seam and the checks are unit-testable against a fake provider.

### Browser lifecycle

- The engine creates a `LazyBrowser` before running checks: it does not launch Chromium yet.
- On the first `newPage()`/`cdpEndpoint()` call, it dynamically imports `playwright`, launches `chromium` headless, and memoizes the browser.
- Each `newPage()` creates a fresh `BrowserContext` + `Page` (isolation), registered for teardown.
- After all checks complete (success or error), the engine closes every page/context and the browser, then awaits process cleanup. A per-page navigation timeout (default 30s) and an overall browser-launch timeout (default 60s) bound hangs.
- Launch failure (e.g. peer dep present but `npx playwright install` never run) is caught: the affected browser checks report `error` status (excluded from scoring, surfaced with the exact remediation command) rather than crashing the run. This is distinct from capability-unavailable (peer dep missing → `skipped`): dep-present-but-browser-missing → per-check `error` with the install-chromium hint.

### The four checks

| Check               | id                             | category      | needs beyond Playwright                     | default severity                                                   |
| ------------------- | ------------------------------ | ------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| Console errors      | `functionality.console-errors` | functionality | —                                           | error (uncaught JS), warning (failed request)                      |
| Accessibility (axe) | `accessibility.axe`            | accessibility | `@axe-core/playwright` (also optional peer) | error (serious/critical), warning (moderate)                       |
| Lighthouse / CWV    | `performance.lighthouse`       | performance   | `lighthouse`                                | warning (advisory) → error when a configured threshold is exceeded |
| Analytics           | `operations.analytics`         | operations    | —                                           | warning                                                            |

- **Which pages:** browser checks are expensive, so they sample the crawl rather than visiting every page. Default: the base URL plus up to `browserSampleSize` (default 5) additional crawled HTML pages (configurable; `0` = base URL only). The sampled set is shared across browser checks so each page is visited once per check, not once per check per page beyond the sample. Console-errors and axe iterate the sample; Lighthouse runs on the base URL only by default (it is the heaviest) with an optional `lighthouse.urls` list; analytics runs on the base URL plus one deep page.
- **console-errors:** load each sampled page, collect `page.on("console")` error-level messages, `page.on("pageerror")`, and `page.on("requestfailed")`; whitelist noisy third parties via `ignore` option (substring match on message/URL). Uncaught exceptions → error; failed sub-resource requests → warning; mixed severities per page aggregated.
- **accessibility.axe:** inject axe-core via `@axe-core/playwright`, run against each sampled page, map axe impact to severity (critical/serious → error, moderate → warning, minor → info); the report must say "automated scan passed" not "accessible" (honesty boundary from the core spec). `axe` options: `standard` (default wcag2a+wcag2aa), `ignore` rule IDs.
- **performance.lighthouse:** run Lighthouse against the base URL over the shared Chromium CDP endpoint, `numberOfRuns: 1` in v1 (median-of-3 is a config option, off by default for speed). Extract category scores (performance/accessibility/best-practices/seo) and CWV numerics (LCP, CLS, TBT as INP proxy). Findings are **advisory warnings** unless the config sets a threshold (`lighthouse.minScores`, `lighthouse.maxMetrics`), which promotes a breach to error. Lab-data caveat noted in every finding.
- **operations.analytics:** load the base URL (and one deep page) with request interception; assert the configured analytics endpoint fires (GA4 `google-analytics.com`/`googletagmanager.com`, Plausible, Fathom — detected or configured via `analytics.provider`/`analytics.propertyId`); flag zero hits (warning), the wrong property ID (warning — e.g. staging ID in production), and double-firing (warning).

### Scoring & report

- Report schema is UNCHANGED (no `REPORT_VERSION` bump) — browser checks emit the same `Finding`/category structure. New categories `accessibility`, `performance`, `operations` already exist in `CategoryId`.
- console-errors/axe/analytics use the page-clean-ratio model over their sampled pages; Lighthouse uses the deduction model (single-target, site-level).
- Every browser check is `blocking: false` in v1 EXCEPT `functionality.console-errors` (uncaught JS errors are `blocking: true` — a broken script is a functional defect). Rationale documented so it's a deliberate choice, consistent with the fetch tier's blocking calls; revisit per-check as budgets mature.

## Components (file structure)

```
src/browser/types.ts            BrowserProvider, BrowserPage interfaces (no playwright import)
src/browser/lazy-browser.ts     LazyBrowser: capability probe + lifecycle + teardown
src/browser/playwright-driver.ts the ONLY dynamic `import("playwright")`; implements the interfaces
src/engine/runner.ts            +capability partition; injects browser provider into browser-check contexts
src/engine/run-review.ts        constructs LazyBrowser, wires teardown, records skips
src/checks/functionality/console-errors.ts   (PR 12)
src/checks/accessibility/axe.ts              (PR 13)
src/checks/performance/lighthouse.ts         (PR 14)
src/checks/operations/analytics.ts           (PR 15)
tests/helpers/fake-browser.ts   in-memory BrowserProvider for unit-testing checks without Chromium
```

## Error handling

- Peer dep absent → check `skipped` (reason names the install command).
- Peer dep present, Chromium missing/launch fails → affected checks `error` (excluded from scoring; remediation = `npx playwright install chromium`); the run and all fetch-tier checks complete normally.
- Per-page navigation timeout → that page contributes a `warning` (couldn't assess), not a whole-check crash.
- The engine ALWAYS tears the browser down in a `finally`, even if a check throws.

## Testing strategy

- **Check unit tests** run against `tests/helpers/fake-browser.ts` — a `BrowserProvider` that serves canned pages/console-events/intercepted-requests with zero Chromium. This keeps the 90% coverage gate reachable without a browser in the fast test path.
- **A small real-browser smoke suite** (tagged, gated on `playwright` being installed) launches actual Chromium against a local fixture server for each check — proves the driver + Lighthouse-over-CDP wiring end-to-end. Skipped automatically when Chromium is absent (so `npm test` stays green on a lean checkout).
- **CI:** the `verify` job installs `playwright` (a devDependency of the repo) and runs `npx playwright install --with-deps chromium` (cached by version) so both the fast and smoke suites run in CI.
- The capability-skip path is unit-tested by pointing the probe at a non-importable module name.

## Dependency posture (eval-dependency)

- `playwright` and `lighthouse` are vetted before adoption (widely-used, Microsoft/Google-maintained, the de-facto tools the core spec named). They are **devDependencies of this repo** (for self-testing) and **optional peerDependencies for consumers**. `@axe-core/playwright` (+`axe-core`) same posture, introduced in PR 13.
- The dynamic-import seam means a consumer who never installs the peers ships zero browser code paths at runtime and pays no install cost.
- CI runtime posture note: browser checks drive a real browser against the target site — the same "hostile input" caveat applies; Chromium runs headless with no persistent profile, one ephemeral context per page.

## Non-goals (v1)

- Visual regression / screenshot diffing (a distinct future check).
- Cross-browser matrix (Firefox/WebKit) — chromium only in v1.
- Real-user/field data (CrUX) — lab data only, caveated.
- Keyboard-navigation / focus-order assertions (a later accessibility PR).
- median-of-N Lighthouse by default (opt-in only).

## Build order

- **PR 12** — browser infrastructure (`src/browser/*`, capability partition, provider injection, teardown, CI Chromium install, fake-browser test helper) **+ `functionality.console-errors`** (lightest real check, proves the rig).
- **PR 13** — `accessibility.axe` (+ `@axe-core/playwright` peer).
- **PR 14** — `performance.lighthouse` (+ `lighthouse` peer; CDP reuse; advisory budgets).
- **PR 15** — `operations.analytics` (request interception).

Each PR: TDD, per-task reviews, whole-branch review, ledgered — same cadence as PRs 1–11.
