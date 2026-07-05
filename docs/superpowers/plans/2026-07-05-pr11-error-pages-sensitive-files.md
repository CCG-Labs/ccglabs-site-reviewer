# Site Reviewer PR 11 (functionality.error-pages + security.sensitive-files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the fetch-adjacent set: `functionality.error-pages` (soft-404 detection + branded-404 marker) and `security.sensitive-files` (probes for exposed `/.env`, `/.git/HEAD`, backups, etc.) — and land the shared probe-cache helper ride-along that deduplicates four hand-rolled copies.

**Architecture:** Ride-along first: a `createProbeCache(fetch, shouldFallBackToGet?)` factory returns a memoized `probe(url) → ProbeResult` (full response: reachable/status/headers/error); the three existing checks (`links`, `social-meta`, `images`) adopt it, each passing its own fallback predicate so behavior is byte-identical. Then two new checks, both probe-based, both using the shared helper. `functionality.error-pages` requests a guaranteed-nonexistent path and asserts a real 404 (not a soft-200) plus optional branded-marker text. `security.sensitive-files` probes a configurable list of sensitive paths and flags any that return 200 with plausible content.

**Tech Stack:** existing fetcher/PageStore. No new dependencies.

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`. Report schema UNCHANGED.
- No `eval` / `new Function` / `child_process`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- **Ride-along (dedup):** `src/checks/probe-cache.ts` exports:
  ```ts
  export interface ProbeResult {
    reachable: boolean;
    status: number; // 0 when unreachable
    headers: Record<string, string>;
    body: string; // populated only when a GET was performed; "" otherwise
    error: string | undefined; // set iff !reachable
  }
  export function createProbeCache(
    fetchFn: RateLimitedFetch,
    shouldFallBackToGet?: (headStatus: number) => boolean, // default: (s) => s >= 400
  ): (url: string) => Promise<ProbeResult>;
  ```
  - `probe(url)`: memoized per URL (one in-flight promise). HEAD first; if `shouldFallBackToGet(headStatus)` then GET and return the GET's status/headers/body. Network error → `{ reachable: false, status: 0, headers: {}, body: "", error }`. On success `reachable: true`.
  - The three existing checks adopt it and MUST stay behavior-identical (the review gate): `links` passes the default (`>= 400`, already its behavior); `social-meta` and `images` pass `(s) => s === 405 || s === 501` to preserve their exact current fallback. Each check keeps its own result-shaping (links reads status+error, social-meta reads status+content-type, images reads content-length) by mapping over `ProbeResult`. No existing test changes; no finding text changes.
- `functionality.error-pages`: id `functionality.error-pages`, category `functionality`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`.
  - Probe `new URL("/__site-review-should-404__/" + random, baseUrl)` (a guaranteed-nonexistent path; append a short random suffix so caching/CDN can't serve a real page).
  - Soft-404 detection: response status **200** for the nonexistent path → **error** ("returns HTTP 200 for a nonexistent URL (soft 404) — search engines can't tell real pages from missing ones").
  - Status is a redirect (3xx) for the nonexistent path → **warning** (redirecting unknown URLs to home is a soft-404 variant).
  - Status is 404 (correct) but a `notFoundMarker` option is configured and the 404 body does not contain it → **warning** ("404 responds correctly but the branded 404 page marker was not found"). When `notFoundMarker` is unset, a correct 404 → pass, no marker check.
  - Unreachable → **warning** ("could not verify 404 handling").
  - Options: `notFoundMarker: string` (substring expected in the branded 404 body).
  - Scoring: deduction model `max(0, 100 − 20·errors − 5·warnings)` (single-probe, site-level).
- `security.sensitive-files`: id `security.sensitive-files`, category `security`, `blocking: true`, weight 1, environments `["ci", "production"]` (local dev servers routinely expose these; not meaningful there).
  - Default probe list (relative to origin): `/.env`, `/.git/HEAD`, `/.git/config`, `/wp-config.php.bak`, `/config.php.bak`, `/backup.sql`, `/database.sql`, `/dump.sql`, `/.DS_Store`, `/.htaccess`, `/id_rsa`, `/.aws/credentials`, `/phpinfo.php`.
  - For each path: probe (HEAD→GET-fallback via the shared helper). A path is EXPOSED when status is 200 AND (for the GET body when available) the body is non-empty. → **error** per exposed path ("sensitive file is publicly accessible: <path>").
  - Content sanity to cut false positives: a 200 whose body looks like the site's own HTML 404-ish page is still flagged only if the path's own signature matches — keep it simple: flag any 200 with a non-empty body whose `content-type` is NOT `text/html` OR (is html but the path is a known non-html artifact). Concretely: flag when `status === 200 && body.trim() !== "" && !contentTypeIsHtml`. A site that serves a styled 200 HTML page for everything (SPA catch-all) then does NOT trip these (its `/.env` returns HTML) — documented limitation, note it.
  - Options: `paths: string[]` (REPLACES the default list when provided), `additionalPaths: string[]` (appended to defaults), `ignore: string[]` (substrings to skip).
  - Probe cap: the default list is small; a config `paths` list is capped at 100 (debug-logged overflow).
  - Scoring: deduction model `max(0, 100 − 20·errors − 5·warnings)`.
- Conventional commits. Branch: `feat/error-pages-sensitive-files` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/checks/probe-cache.ts               createProbeCache + ProbeResult (shared)
src/checks/functionality/links.ts       (ride-along) adopt shared cache
src/checks/seo/social-meta.ts           (ride-along) adopt shared cache
src/checks/content/images.ts            (ride-along) adopt shared cache
src/checks/functionality/error-pages.ts errorPagesCheck
src/checks/security/sensitive-files.ts  sensitiveFilesCheck
src/engine/registry.ts                  register both
README.md                               checks table rows
```

---

### Task 1: Shared probe-cache helper + adopt in 3 checks

**Files:**

- Create: `src/checks/probe-cache.ts`
- Modify: `src/checks/functionality/links.ts`, `src/checks/seo/social-meta.ts`, `src/checks/content/images.ts`
- Test: `tests/probe-cache.test.ts`

**Interfaces:**

- Produces: `ProbeResult`, `createProbeCache(fetchFn, shouldFallBackToGet?)` from `src/checks/probe-cache.ts`.

- [ ] **Step 1: Write the failing test** — `tests/probe-cache.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createProbeCache } from "../src/checks/probe-cache.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createProbeCache", () => {
  it("returns HEAD status without falling back when the predicate is not met", async () => {
    const methods: string[] = [];
    server = await startServer((req, res) => {
      methods.push(req.method ?? "");
      res.statusCode = 200;
      res.end("body");
    });
    const probe = createProbeCache(createFetcher());
    const result = await probe(server.url);
    expect(result).toMatchObject({ reachable: true, status: 200, body: "" });
    expect(methods).toEqual(["HEAD"]);
  });

  it("falls back to GET (capturing body) when the predicate matches", async () => {
    const methods: string[] = [];
    server = await startServer((req, res) => {
      methods.push(req.method ?? "");
      res.statusCode = req.method === "HEAD" ? 405 : 200;
      res.end(req.method === "HEAD" ? "" : "the body");
    });
    const probe = createProbeCache(createFetcher(), (status) => status === 405);
    const result = await probe(server.url);
    expect(result.status).toBe(200);
    expect(result.body).toBe("the body");
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("uses the default >= 400 fallback predicate", async () => {
    const methods: string[] = [];
    server = await startServer((req, res) => {
      methods.push(req.method ?? "");
      res.statusCode = req.method === "HEAD" ? 403 : 200;
      res.end(req.method === "HEAD" ? "" : "ok");
    });
    const result = await createProbeCache(createFetcher())(server.url);
    expect(result.status).toBe(200);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("memoizes: one probe per URL even across concurrent calls", async () => {
    let hits = 0;
    server = await startServer((_req, res) => {
      hits += 1;
      res.end("x");
    });
    const probe = createProbeCache(createFetcher());
    const url = server.url;
    await Promise.all([probe(url), probe(url), probe(url)]);
    expect(hits).toBe(1);
  });

  it("reports network failure as unreachable with a message", async () => {
    const result = await createProbeCache(createFetcher({ timeoutMs: 300 }))("http://127.0.0.1:1");
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).not.toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/probe-cache.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/probe-cache.ts`**

```ts
import type { RateLimitedFetch } from "../types.js";

export interface ProbeResult {
  reachable: boolean;
  /** 0 when unreachable */
  status: number;
  headers: Record<string, string>;
  /** the GET body when a GET was performed; "" otherwise */
  body: string;
  /** set only when !reachable */
  error: string | undefined;
}

const UNREACHABLE = (error: string): ProbeResult => ({
  reachable: false,
  status: 0,
  headers: {},
  body: "",
  error,
});

/**
 * A per-URL memoized prober shared across checks. HEAD first; if
 * shouldFallBackToGet(headStatus) is true, a GET is issued and its
 * status/headers/body returned. One in-flight promise per URL.
 */
export function createProbeCache(
  fetchFn: RateLimitedFetch,
  shouldFallBackToGet: (headStatus: number) => boolean = (status) => status >= 400,
): (url: string) => Promise<ProbeResult> {
  const cache = new Map<string, Promise<ProbeResult>>();
  return (url) => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const result = (async (): Promise<ProbeResult> => {
      try {
        const head = await fetchFn(url, { method: "HEAD" });
        if (shouldFallBackToGet(head.status)) {
          const get = await fetchFn(url);
          return {
            reachable: true,
            status: get.status,
            headers: get.headers,
            body: get.body,
            error: undefined,
          };
        }
        return {
          reachable: true,
          status: head.status,
          headers: head.headers,
          body: "",
          error: undefined,
        };
      } catch (error) {
        return UNREACHABLE(error instanceof Error ? error.message : String(error));
      }
    })();
    cache.set(url, result);
    return result;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/probe-cache.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Adopt in `links.ts`.** Replace the local `probeCache`/`probe` block with `const probe = createProbeCache(ctx.fetch);` (default `>=400` fallback — its current behavior). Map the shared `ProbeResult` to the check's existing `ProbeResult` local type at each call site, OR delete the local type and use the shared one: `links.ts` currently branches on `result.kind`. Simplest: keep the call sites, adapt them — where it did `if (result.kind === "unreachable")` use `if (!result.reachable)` (message from `result.error ?? "unreachable"`), and `result.status` otherwise. Remove the now-unused local `ProbeResult` type. Import `createProbeCache` from `../probe-cache.js`.

- [ ] **Step 6: Adopt in `social-meta.ts`.** `const probe = createProbeCache(ctx.fetch, (status) => status === 405 || status === 501);` (preserves its exact fallback). Its checkImage read `result.status` and `result.contentType` → now `result.status` and `result.headers["content-type"] ?? ""`; unreachable via `!result.reachable`. Remove the local `ProbeResult` type.

- [ ] **Step 7: Adopt in `images.ts`.** `const contentLengthProbe = createProbeCache(ctx.fetch, (status) => status === 405 || status === 501);` The `contentLength(url)` helper becomes a thin wrapper: `const r = await contentLengthProbe(url); const raw = r.reachable ? r.headers["content-length"] : undefined; …parse…`. Remove the local `probeCache`.

- [ ] **Step 8: Behavioral-drift gate**

Run: `npx vitest run` — Expected: ALL existing tests pass UNCHANGED (the three checks' tests especially — links/social-meta/images). If any fail, the adoption changed behavior; root-cause, do NOT touch the test.
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract shared probe-cache helper adopted by links, social-meta, and images"
```

---

### Task 2: functionality.error-pages

**Files:**

- Create: `src/checks/functionality/error-pages.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-error-pages.test.ts`

**Interfaces:**

- Consumes: `createProbeCache` (Task 1), `ctx.fetch`, `ctx.baseUrl`, `fixturePageStore` (for context, though this check reads no pages).
- Produces: `errorPagesCheck: Check` (id `functionality.error-pages`) registered after `crawlCoverageCheck` (keep functionality checks adjacent).

Write `src/checks/functionality/error-pages.ts`:

```ts
import { createProbeCache } from "../probe-cache.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const ERROR_COST = 20;
const WARNING_COST = 5;

function notFoundMarker(ctx: CheckContext): string | undefined {
  const raw = ctx.config.checks["functionality.error-pages"]?.options?.["notFoundMarker"];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

export const errorPagesCheck: Check = {
  id: "functionality.error-pages",
  category: "functionality",
  description:
    "Requests for nonexistent URLs return a real 404 (not a soft 200) and a branded 404 page.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    // GET the probe directly so we always have the body for the marker check.
    const probeUrl = new URL(
      `/__site-review-should-404__/${Math.random().toString(36).slice(2)}`,
      ctx.baseUrl,
    ).href;
    const findings: Finding[] = [];
    const marker = notFoundMarker(ctx);

    let status: number;
    let body: string;
    try {
      const response = await ctx.fetch(probeUrl);
      status = response.status;
      body = response.body;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.debug("404 probe failed", { message });
      return {
        score: 95,
        findings: [
          {
            severity: "warning",
            url: probeUrl,
            message: `Could not verify 404 handling: ${message}`,
            recommendation: "Ensure the site is reachable so 404 behavior can be checked.",
          },
        ],
      };
    }

    if (status === 200) {
      findings.push({
        severity: "error",
        url: probeUrl,
        message: "A nonexistent URL returns HTTP 200 (soft 404).",
        recommendation:
          "Return a real 404 status for missing pages — soft 404s let search engines index nothing pages and hide broken links.",
      });
    } else if (status >= 300 && status < 400) {
      findings.push({
        severity: "warning",
        url: probeUrl,
        message: `A nonexistent URL redirects (HTTP ${String(status)}) instead of returning 404.`,
        recommendation: "Return a 404 for missing pages rather than redirecting to the homepage.",
      });
    } else if (status === 404 && marker !== undefined && !body.includes(marker)) {
      findings.push({
        severity: "warning",
        url: probeUrl,
        message: `404 status is correct but the expected branded-404 marker "${marker}" was not found.`,
        recommendation: "Confirm the custom 404 page (with navigation) is served for missing URLs.",
      });
    }

    ctx.logger.debug("Error-page probe", { status, findings: findings.length });
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};
```

(Note: this check GETs the probe URL directly rather than via `createProbeCache`, because it always needs the body for the marker check and there is only one URL — the shared helper is not needed here. `createProbeCache` import can be dropped if unused; keep the check self-contained. Adjust the import line accordingly during implementation.)

Register in `src/engine/registry.ts` after `crawlCoverageCheck`.

Tests (`tests/check-error-pages.test.ts`) — real `startServer` (this check hits the network via ctx.fetch, like reachable/probe tests). Numbered spec:

1. Registered as a built-in.
2. Server that 404s unknown paths → `{ score: 100, findings: [] }`.
3. Server that 200s everything (soft 404) → error "soft 404", score 80.
4. Server that 302-redirects unknown paths → warning, score 95.
5. `notFoundMarker` set + 404 body contains it → pass; 404 body lacks it → warning.
6. Unreachable base (`http://127.0.0.1:1`, short timeout via config? — the check uses ctx.fetch; construct the context's fetch with a short timeout) → warning "could not verify", score 95.
7. Empty/irrelevant store is fine — this check ignores pages.

TDD: tests first, implement, PASS, `npm run format && npm run verify`, commit:

```bash
git add src/checks/functionality/error-pages.ts src/engine/registry.ts tests/check-error-pages.test.ts
git commit -m "feat: add functionality.error-pages check detecting soft 404s"
```

---

### Task 3: security.sensitive-files

**Files:**

- Create: `src/checks/security/sensitive-files.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-sensitive-files.test.ts`

**Interfaces:**

- Consumes: `createProbeCache` (Task 1), `ctx.fetch`, `ctx.baseUrl`.
- Produces: `sensitiveFilesCheck: Check` (id `security.sensitive-files`) registered after `securityTlsCheck`.

Write `src/checks/security/sensitive-files.ts`:

```ts
import { createProbeCache } from "../probe-cache.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const ERROR_COST = 20;
const WARNING_COST = 5;
const MAX_PATHS = 100;

const DEFAULT_PATHS = [
  "/.env",
  "/.git/HEAD",
  "/.git/config",
  "/wp-config.php.bak",
  "/config.php.bak",
  "/backup.sql",
  "/database.sql",
  "/dump.sql",
  "/.DS_Store",
  "/.htaccess",
  "/id_rsa",
  "/.aws/credentials",
  "/phpinfo.php",
];

interface SensitiveFilesOptions {
  paths: string[];
  ignore: string[];
}

function sensitiveFilesOptions(ctx: CheckContext): SensitiveFilesOptions {
  const raw = ctx.config.checks["security.sensitive-files"]?.options;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const replacement = strings(raw?.["paths"]);
  const additional = strings(raw?.["additionalPaths"]);
  const paths = (replacement.length > 0 ? replacement : DEFAULT_PATHS).concat(additional);
  return { paths: paths.slice(0, MAX_PATHS), ignore: strings(raw?.["ignore"]) };
}

const isHtml = (headers: Record<string, string>): boolean =>
  (headers["content-type"] ?? "").includes("text/html");

export const sensitiveFilesCheck: Check = {
  id: "security.sensitive-files",
  category: "security",
  description: "Sensitive files (.env, .git, backups) are not publicly accessible.",
  environments: ["ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const options = sensitiveFilesOptions(ctx);
    const probe = createProbeCache(ctx.fetch); // default >= 400 fallback: probe bodies on any non-2xx HEAD
    const origin = new URL(ctx.baseUrl).origin;
    const findings: Finding[] = [];

    await Promise.all(
      options.paths
        .filter((path) => !options.ignore.some((pattern) => path.includes(pattern)))
        .map(async (path) => {
          const url = new URL(path, origin).href;
          const result = await probe(url);
          // Exposed = 200 with non-empty, non-HTML body (HTML 200 is almost always a catch-all page).
          if (
            result.reachable &&
            result.status === 200 &&
            result.body.trim() !== "" &&
            !isHtml(result.headers)
          ) {
            findings.push({
              severity: "error",
              url,
              message: `Sensitive file is publicly accessible: ${path} (HTTP 200).`,
              recommendation: `Block public access to ${path} at the server/CDN — it can leak credentials or source.`,
            });
          }
        }),
    );

    ctx.logger.debug("Sensitive-file scan", {
      probed: options.paths.length,
      findings: findings.length,
    });
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};
```

Note: `createProbeCache(ctx.fetch)` default `>=400` fallback means a HEAD returning non-200 triggers a GET — so we get the body to judge exposure. A path that HEAD-200s returns `body: ""` (no fallback) — for those we cannot see the body. Adjust: for THIS check we always want the body, so probe with a predicate that ALWAYS falls back to GET is wrong (double request on 200). Simplest correct approach: this check does its own single GET per path (bodies always needed), OR pass `shouldFallBackToGet: () => true`? No — that GETs twice when HEAD already 200. Cleanest: for sensitive-files, do a direct `ctx.fetch(url)` (GET) per unique path with a small local memo, since the body is always required. Rewrite the probe line as a direct GET loop; drop the shared-cache import here if it causes a double-fetch. Implementer: use a direct GET (`await ctx.fetch(url)`) per path — bodies are always needed and the list is short — and skip the shared helper for this check. Keep the exposure logic identical.

Register in `src/engine/registry.ts` after `securityTlsCheck`.

Tests (`tests/check-sensitive-files.test.ts`) — real `startServer` routing specific paths:

1. Registered as a built-in.
2. Server 404ing every sensitive path → `{ score: 100, findings: [] }`.
3. Server serving `/.env` with `DB_PASSWORD=secret` and `content-type: text/plain` (200) → error naming `/.env`, score 80.
4. Server serving `/.git/HEAD` `ref: refs/heads/main` text/plain 200 → error.
5. Catch-all SPA server returning 200 `text/html` for everything (including `/.env`) → NO findings (html-200 not flagged), score 100 (documents the limitation).
6. `additionalPaths: ["/secret.txt"]` served 200 text/plain → error; defaults still probed.
7. `paths: ["/only-this"]` REPLACES defaults → `/.env` not probed (assert via server hit log).
8. `ignore: [".git"]` skips the .git paths.
9. Empty body 200 (`/.env` returns 200 but empty) → not flagged (non-empty required).

TDD: tests first, implement, PASS, `npm run format && npm run verify`, commit:

```bash
git add src/checks/security/sensitive-files.ts src/engine/registry.ts tests/check-sensitive-files.test.ts
git commit -m "feat: add security.sensitive-files check probing for exposed files"
```

---

### Task 4: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Integration test** — append to `tests/run-review.test.ts`:

```ts
it("surfaces soft-404 and exposed-file issues from a live crawl", async () => {
  server = await startServer((req, res) => {
    if (req.url?.startsWith("/.env")) {
      res.setHeader("content-type", "text/plain");
      res.end("DB_PASSWORD=hunter2");
      return;
    }
    // soft-404: everything returns 200 HTML
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
  });
  const report = await runReview({ url: server.url, environment: "production" });
  const functionality = report.categories.find((category) => category.id === "functionality");
  const security = report.categories.find((category) => category.id === "security");
  expect(
    functionality?.checks
      .find((entry) => entry.id === "functionality.error-pages")
      ?.findings.some((finding) => finding.message.includes("soft 404")),
  ).toBe(true);
  expect(
    security?.checks
      .find((entry) => entry.id === "security.sensitive-files")
      ?.findings.some((finding) => finding.message.includes("/.env")),
  ).toBe(true);
});
```

(Note: environment "production" so `security.sensitive-files` runs; that also runs `security.tls`, which will probe the http fixture's cert — tls's http-no-upgrade path yields an error but this test only asserts the two checks above; confirm the assertions are scoped and don't depend on overall grade.)

- [ ] **Step 2: README rows** (after `content.images`):

```markdown
| `functionality.error-pages` | nonexistent URLs return a real 404 (soft-200 is an error, redirect a warning); optional branded-404 marker check |
| `security.sensitive-files` | probes for publicly accessible `.env`, `.git`, backups, key files (ci + production) |
```

- [ ] **Step 3: Verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: local fixture serving `/.env` + soft-404 via `node dist/cli.js <url> --env production --format console` (integration test covers the path if the sandbox blocks the subprocess).

```bash
git add -A
git commit -m "feat: document error-page and sensitive-file checks and add integration coverage"
git push -u origin feat/error-pages-sensitive-files
gh pr create --base main --title "feat: error-pages + sensitive-files checks (PR 11)" --body "PR 11 of the roadmap — completes the fetch-adjacent set. functionality.error-pages: probes a guaranteed-nonexistent URL, flags soft-404 (200 → error), redirect-to-home (warning), and an optional branded-404 marker. security.sensitive-files: probes .env/.git/backups/key files (ci + production), flags any 200 with a non-empty non-HTML body. Dedup ride-along: a shared createProbeCache helper replaces four hand-rolled per-URL caches (links/social-meta/images adopt it behavior-identically). No report schema change; no new dependencies.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

The fetch tier and its adjacent checks are done (15 checks). PRs 12–15 are the BROWSER TIER (Lighthouse/CWV, axe accessibility, console errors, analytics), which require Playwright/Lighthouse as OPTIONAL PEER DEPENDENCIES — this needs a dedicated planning conversation: eval-dependency vetting of playwright + @lhci/cli or lighthouse, the optional-install/graceful-skip UX (checks that skip with a clear "install X to enable" reason when the peer dep is absent), and a heavier CI setup (browser download). Do NOT start PR 12 without that planning step.
