# PR 15: operations.analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `operations.analytics` check — verify the site's analytics actually fires (GA4/Plausible/Fathom auto-detected or configured), with the right property ID and without double-firing, via the existing `onRequest` interception.

**Architecture:** The check loads the base URL plus one deep page, records every outgoing request URL through `BrowserPage.onRequest` (registered before `goto`), waits a configurable settle period for async beacons, then classifies requests against a provider table (hosts + hit/pageview/property-ID extractors, URL-only — request bodies are not available at this seam). Zero hits, a mismatched property ID, and duplicate pageviews each draw a warning; page-clean-ratio scoring.

**Tech Stack:** existing `BrowserPage.onRequest` seam (PR 12), fake-browser `requests` scripting (already present), vitest. NO new dependencies, NO interface changes.

## Global Constraints

- Check: id `operations.analytics`, category `operations` (already in `CATEGORY_IDS`), `requires: "browser"`, `blocking: false`, `weight: 1`, `environments: ["production"]` — analytics is routinely (and correctly) absent on local/CI, so zero-hit warnings there would be noise; overridable via config env overrides.
- All analytics findings are **warnings** (per the browser-tier spec table). Page-clean-ratio scoring: a page with any analytics finding is dirty; a nav-failure warning does NOT dirty the page (mirrors `accessibility.axe`).
- Pages: `samplePages(ctx.pages.all(), ctx.baseUrl, 1)` — base URL + one deep page.
- Detection is URL/method-only (the `onRequest` seam carries no bodies). Property-ID verification happens only where the ID is extractable from the URL (GA4 `tid`/`id`, Fathom `sid`); Plausible carries its domain in the POST body, so no ID check there.
- No `eval`/`child_process`; no new deps; TypeScript strict, no `any`; per-page failures never destroy the report; `page.close()` on all paths (try/finally).
- `npm run format && npm run verify` green after every task; commit per task.

---

### Task 1: the operations.analytics check

**Files:**

- Create: `src/checks/operations/analytics.ts`
- Modify: `src/engine/registry.ts` (register after `lighthouseCheck`)
- Test: `tests/check-analytics.test.ts`

**Interfaces:**

- Consumes: `BrowserPage.onRequest(handler(url, method))` and `samplePages` (existing); `FakePageScript.requests?: Array<{url, method}>` (existing — fires handlers during `goto`).
- Produces: nothing consumed by later tasks beyond the registered check.

- [ ] **Step 1: Write the failing tests**

Create `tests/check-analytics.test.ts` modeled on `tests/check-axe.test.ts`'s harness (fakeBrowser + PageStore + config helper) but with **`environment: "production"`** — this check skips local and ci. Every test passes `options: { settleMs: 0, ... }` so no timer runs. Cover as separate `it` blocks:

1. Metadata: id `operations.analytics`, category `operations`, `requires === "browser"`, `blocking === false`, `weight === 1`, environments exactly `["production"]`.
2. Browser absent → `{ score: 100, findings: [] }`.
3. Empty page store (and base URL not crawled) → `{ score: 100, findings: [] }`.
4. GA4 hit, auto-detect: one request `https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view` → no findings, score 100.
5. Zero hits: page with only same-origin requests → one warning per audited page mentioning "No analytics hits"; single-page store → score 0.
6. Loader-but-no-events: request to `https://www.googletagmanager.com/gtag/js?id=G-ABC123` and NO collect hit → warning message mentions the tag script loaded but no events fired (consent manager/blocker hint); page dirty.
7. Wrong property ID: options `{ propertyId: "G-PROD456" }`, collect hit with `tid=G-STAGING1` → warning naming BOTH the observed and expected IDs; page dirty.
8. Matching property ID (case-insensitive): options `{ propertyId: "g-abc123" }`, hit with `tid=G-ABC123` → no findings, score 100.
9. Double-firing: two collect hits with `en=page_view` on one page → one warning mentioning the tag may be installed twice; a page with `en=page_view` + `en=scroll` is NOT flagged.
10. Plausible auto-detect: `POST https://plausible.io/api/event` → counts as a hit, no findings; two such POSTs → double-fire warning.
11. Fathom: hit `https://usefathom.com/?sid=FATHOM99&p=%2F` counts; options `{ propertyId: "OTHER1" }` with that hit → wrong-ID warning naming FATHOM99.
12. Provider restriction: options `{ provider: "plausible" }` with only GA4 hits → zero-hits warning (GA4 hits don't count when another provider is configured).
13. Custom hosts: options `{ hosts: ["matomo.example.com"] }`, request to `https://matomo.example.com/matomo.php?idsite=3` → counts as a hit, no findings.
14. Nav failure: two-page store, page one `throwOnGoto`, page two has a GA4 hit → one "could not be loaded" warning, page two clean, score 100 (nav failure doesn't dirty).
15. Deep-page sampling: three crawled pages, none with analytics → exactly TWO zero-hit warnings (base + one deep page only), score 0.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/check-analytics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/checks/operations/analytics.ts`:

```ts
import { samplePages } from "../../browser/sample.js";
import type { Check, CheckContext, Finding } from "../../types.js";

/** Post-load wait for async analytics beacons. */
const DEFAULT_SETTLE_MS = 2000;
const MAX_SETTLE_MS = 10_000;

type ProviderId = "ga4" | "plausible" | "fathom";

interface ProviderSpec {
  label: string;
  /** hostname suffixes owned by this provider */
  hosts: string[];
  /** a tracking hit (an event actually sent), as opposed to the script loader */
  isHit(url: URL, method: string): boolean;
  /** the loader script request — proves the snippet is installed even when nothing fires */
  isLoader(url: URL): boolean;
  /** counts toward double-fire detection */
  isPageview(url: URL, method: string): boolean;
  /** property/site ID carried in the request URL, when extractable */
  propertyId(url: URL): string | null;
}

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  ga4: {
    label: "GA4",
    hosts: ["google-analytics.com", "googletagmanager.com"],
    isHit: (url) => url.pathname.includes("/collect"),
    isLoader: (url) =>
      hostMatches(url.hostname, "googletagmanager.com") && url.pathname.startsWith("/gtag/js"),
    isPageview: (url) =>
      url.pathname.includes("/collect") && url.searchParams.get("en") === "page_view",
    propertyId: (url) => url.searchParams.get("tid") ?? url.searchParams.get("id"),
  },
  plausible: {
    label: "Plausible",
    hosts: ["plausible.io"],
    isHit: (url, method) => url.pathname === "/api/event" && method === "POST",
    isLoader: (url) => url.pathname.startsWith("/js/"),
    // Plausible sends the event name in the POST body (unavailable at this seam);
    // treat every event during initial load as a pageview — a plain load fires exactly one.
    isPageview: (url, method) => url.pathname === "/api/event" && method === "POST",
    propertyId: () => null,
  },
  fathom: {
    label: "Fathom",
    hosts: ["usefathom.com"],
    isHit: (url) => url.searchParams.has("sid"),
    isLoader: (url) => url.pathname.endsWith("/script.js"),
    isPageview: (url) => url.searchParams.has("sid"),
    propertyId: (url) => url.searchParams.get("sid"),
  },
};

interface AnalyticsOptions {
  provider?: ProviderId;
  propertyId?: string;
  /** extra hostname suffixes (self-hosted Plausible, Matomo, Umami, …) counted as hits */
  hosts: string[];
  settleMs: number;
}

function analyticsOptions(ctx: CheckContext): AnalyticsOptions {
  const raw = ctx.config.checks["operations.analytics"]?.options;
  const provider = raw?.["provider"];
  const propertyId = raw?.["propertyId"];
  const settle = raw?.["settleMs"];
  return {
    provider:
      provider === "ga4" || provider === "plausible" || provider === "fathom"
        ? provider
        : undefined,
    propertyId: typeof propertyId === "string" && propertyId !== "" ? propertyId : undefined,
    hosts: Array.isArray(raw?.["hosts"])
      ? raw["hosts"].filter((entry): entry is string => typeof entry === "string")
      : [],
    settleMs:
      typeof settle === "number" && Number.isFinite(settle)
        ? Math.min(MAX_SETTLE_MS, Math.max(0, Math.round(settle)))
        : DEFAULT_SETTLE_MS,
  };
}

interface PageObservation {
  hits: number;
  pageviews: number;
  loaderSeen: boolean;
  observedIds: Set<string>;
}

function observe(
  requests: Array<{ url: string; method: string }>,
  options: AnalyticsOptions,
): PageObservation {
  const specs =
    options.provider === undefined ? Object.values(PROVIDERS) : [PROVIDERS[options.provider]];
  const result: PageObservation = {
    hits: 0,
    pageviews: 0,
    loaderSeen: false,
    observedIds: new Set(),
  };
  for (const request of requests) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }
    if (options.hosts.some((suffix) => hostMatches(url.hostname, suffix))) {
      result.hits += 1;
      result.pageviews += 1;
      continue;
    }
    for (const spec of specs) {
      if (!spec.hosts.some((suffix) => hostMatches(url.hostname, suffix))) continue;
      if (spec.isLoader(url)) result.loaderSeen = true;
      if (spec.isHit(url, request.method)) {
        result.hits += 1;
        if (spec.isPageview(url, request.method)) result.pageviews += 1;
        const id = spec.propertyId(url);
        if (id !== null) result.observedIds.add(id);
      }
      break;
    }
  }
  return result;
}

export const analyticsCheck: Check = {
  id: "operations.analytics",
  category: "operations",
  description:
    "Verifies analytics actually fires (GA4/Plausible/Fathom auto-detected, or configured) with the expected property ID and no double-firing.",
  environments: ["production"],
  requires: "browser",
  blocking: false,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const targets = samplePages(ctx.pages.all(), ctx.baseUrl, 1);
    if (targets.length === 0) return { score: 100, findings: [] };

    const options = analyticsOptions(ctx);
    const findings: Finding[] = [];
    const dirtyPages = new Set<string>();

    for (const target of targets) {
      const page = await browser.newPage();
      try {
        const requests: Array<{ url: string; method: string }> = [];
        page.onRequest((url, method) => requests.push({ url, method }));
        try {
          await page.goto(target.url);
        } catch (error) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: `Page could not be loaded for the analytics check: ${error instanceof Error ? error.message : String(error)}`,
            recommendation:
              "Re-run; if this persists the page may hang or block automated browsers.",
          });
          continue;
        }
        if (options.settleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.settleMs));
        }

        const seen = observe(requests, options);

        if (seen.hits === 0) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: seen.loaderSeen
              ? `The analytics tag script loaded on ${target.url}, but no events fired (waited ${String(options.settleMs)} ms) — a consent manager or blocker may be suppressing it.`
              : `No analytics hits observed on ${target.url} (waited ${String(options.settleMs)} ms after load).`,
            recommendation:
              "Install or fix the analytics snippet; if this site intentionally has no analytics, disable this check in the config.",
          });
          dirtyPages.add(target.url);
        }

        if (
          options.propertyId !== undefined &&
          seen.observedIds.size > 0 &&
          ![...seen.observedIds].some(
            (id) => id.toLowerCase() === options.propertyId?.toLowerCase(),
          )
        ) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: `Analytics fired with property ID ${[...seen.observedIds].join(", ")} on ${target.url}, expected ${options.propertyId}.`,
            recommendation:
              "A staging/wrong property ID pollutes production data — point the snippet at the expected property.",
          });
          dirtyPages.add(target.url);
        }

        if (seen.pageviews > 1) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: `${String(seen.pageviews)} pageview hits fired on a single load of ${target.url} — the analytics tag may be installed twice.`,
            recommendation:
              "Double-counting inflates traffic metrics; ensure the snippet is included exactly once.",
          });
          dirtyPages.add(target.url);
        }

        ctx.logger.debug("Analytics observation", {
          url: target.url,
          requests: requests.length,
          hits: seen.hits,
          pageviews: seen.pageviews,
          loaderSeen: seen.loaderSeen,
          observedIds: [...seen.observedIds],
        });
      } finally {
        await page.close();
      }
    }

    const cleanPages = targets.length - dirtyPages.size;
    return { score: Math.round((100 * cleanPages) / targets.length), findings };
  },
};
```

- [ ] **Step 4: Register**

In `src/engine/registry.ts`: import `analyticsCheck` from `../checks/operations/analytics.js`, register directly after `lighthouseCheck`.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/check-analytics.test.ts` — all pass; then `npm run format && npm run verify`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add operations.analytics check with provider auto-detection"
```

---

### Task 2: README + integration test + PR

**Files:**

- Modify: `README.md`
- Test: `tests/run-review.test.ts` (append to the self-skipping real-Chromium describe block)

- [ ] **Step 1: Integration test**

Append to the real-browser block in `tests/run-review.test.ts`. Fixture trick — one server, two hostnames: serve the page on `127.0.0.1:<port>` whose HTML fires a beacon to `http://localhost:<port>/beacon` (different hostname, same server), and configure `hosts: ["localhost"]` so only the beacon counts as analytics (the page's own same-host requests use `127.0.0.1` and do not match):

```html
<html>
  <body>
    <script>
      fetch("http://localhost:PORT/beacon");
    </script>
  </body>
</html>
```

Run a review with `environment: "production"`, `checks: { "performance.lighthouse": false, "operations.analytics": { options: { hosts: ["localhost"], settleMs: 500 } } }` (lighthouse disabled — production env would otherwise run a real ~7s audit), plus whatever check-scoping the existing e2es use. Assert the report's `operations` category contains `operations.analytics` with score 100 and no findings (the beacon was detected). Timeout 60_000. Verify it genuinely runs (not skipped) before committing.

- [ ] **Step 2: README**

In "Browser checks (optional)":

- Intro sentence: remove the "in a later release" clause entirely — all four browser checks now ship (`functionality.console-errors`, `accessibility.axe`, `performance.lighthouse`, `operations.analytics`).
- Table row after `performance.lighthouse`:

| `operations.analytics` | operations | Verifies analytics fires (GA4/Plausible/Fathom auto-detected, or configured) with the right property ID and no double-firing. URL-based detection. Runs in `production` only. |

- Options example under the lighthouse one:

```js
// site-review.config.js
export default {
  checks: {
    "operations.analytics": {
      options: {
        provider: "ga4", // restrict detection (default: auto-detect ga4/plausible/fathom)
        propertyId: "G-PROD456", // warn if a different ID fires (staging leak)
        hosts: ["stats.example.com"], // self-hosted endpoints counted as hits
        settleMs: 2000, // post-load wait for async beacons (default 2000)
      },
    },
  },
};
```

- [ ] **Step 3: Verify, commit, PR**

Run: `npm run format && npm run verify` — green.

```bash
git add -A
git commit -m "feat: document the analytics check and add integration coverage"
git push -u origin feat/analytics
gh pr create --title "feat: operations.analytics check (PR 15)" --body "..."
```

PR body: URL-only detection model + its limits (no bodies at the onRequest seam; Plausible ID unverifiable), provider table, production-only rationale, page-clean-ratio, test counts. End with the standard Claude Code attribution.

---

## Self-Review Notes

- Spec coverage: snippet present + events fire ✓ (hit vs loader distinction), property-ID verification ✓ (where URL-extractable; Plausible limitation documented), double-firing ✓ (pageview counting, conservative for body-based providers), zero hits ✓, configured provider/propertyId ✓, base + one deep page ✓, page-clean-ratio ✓, warnings only ✓.
- Type/name consistency: `analyticsCheck` (Task 1) referenced in registry; fake-browser `requests` field already exists — verified against tests/helpers/fake-browser.ts.
- Deliberately omitted (YAGNI): request-body inspection (needs a new seam), Matomo/Umami built-ins (covered by `hosts`), per-event assertions, consent-flow simulation.
