# Site Reviewer PR 6 (seo.sitemap-robots) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `seo.sitemap-robots` check — sitemap existence/validity, every entry 200/canonical/not-noindexed/not-disallowed, completeness cross-check against the crawl, robots.txt sanity — plus five accumulated backlog cleanups as ride-alongs.

**Architecture:** The check fetches `/sitemap.xml` (following up to 10 child sitemaps) and `/robots.txt` via `ctx.fetch`, parses them (reusing the exported `parseSitemapXml`; a new minimal hand-rolled robots parser — no new dependency), and validates every entry against the PageStore (no page re-fetching). Site-level scoring uses a deduction model: `score = max(0, 100 − 20·errors − 5·warnings)` — a ratio over pages doesn't fit site-level artifacts.

**Tech Stack:** cheerio (existing), PageStore, `extractPageMeta`/`headerNoindex` reuse.

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio` (robots.txt parser is hand-rolled). Report schema UNCHANGED.
- No `eval` / `new Function` / `child_process` in `src/`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- Check id `seo.sitemap-robots`, category `seo`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`.
- Severities:
  - sitemap missing (404) / unreachable → **warning**; present-but-empty/unparseable (200, zero `<loc>` and zero child sitemaps) → **error**.
  - entry: invalid URL → **error**; cross-origin → **warning**; unfetchable during crawl (not in store, crawl NOT capped) → **error**; not in store while crawl capped → skipped (debug count); status ≥ 400 → **error**; redirecting (redirected flag or `finalUrl !== url`) → **warning**; noindexed (meta or X-Robots-Tag) → **error**; canonical pointing elsewhere (≠ entry url and ≠ finalUrl) → **warning**; robots-disallowed → **error**.
  - robots.txt missing/unreachable/non-200 → **warning**; base URL disallowed for `*` (blanket block) → **error** in production, **warning** otherwise; robots.txt present + sitemap present but no `Sitemap:` line → **warning**.
  - indexable 2xx HTML crawled page absent from sitemap → **warning** (max 20 individual findings, then one summary warning naming the remaining count).
- robots matching contract: `User-agent: *` group only; literal (wildcard-free) `Disallow`/`Allow` prefixes with Google's longest-match rule; patterns containing `*` or `$` are skipped conservatively (never produce findings) and debug-logged.
- Entry cap: 2000 raw entries collected across root + children (constant `MAX_SITEMAP_ENTRIES`).
- Findings attribution: site-level → `url` = the sitemap/robots URL; entry-level → `url` = the entry; missing-from-sitemap → `url` = the page.
- Ride-alongs (Task 1, from the ledger backlog): (a) links.ts finalUrl index hardened with `normalizePageUrl`; (b) meta-tags flags multiple meta descriptions as error; (c) `noindexAllow` entries normalized via `normalizePageUrl`; (d) `CategoryId` single-sourced from a `CATEGORY_IDS` const consumed by both types.ts and schema.ts (no schema behavior change, no REPORT_VERSION bump); (e) export `parseSitemapXml` (crawl/sitemap.ts) and `headerNoindex` (seo/meta-tags.ts).
- Conventional commits. Branch: `feat/sitemap-robots` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/checks/seo/robots.ts          parseRobotsTxt + isDisallowed (pure)
src/checks/seo/sitemap-robots.ts  sitemapRobotsCheck
src/checks/functionality/links.ts (ride-along a)
src/checks/seo/meta-tags.ts       (ride-alongs b, c, e)
src/crawl/sitemap.ts              (ride-along e)
src/types.ts + src/report/schema.ts (ride-along d)
src/engine/registry.ts            register sitemapRobotsCheck
README.md                         checks table row
```

---

### Task 1: Backlog ride-alongs

**Files:**

- Modify: `src/checks/functionality/links.ts`, `src/checks/seo/meta-tags.ts`, `src/types.ts`, `src/report/schema.ts`, `src/crawl/sitemap.ts`
- Test (modify): `tests/check-links.test.ts`, `tests/check-meta-tags.test.ts`

**Interfaces:**

- Produces: `parseSitemapXml(xml: string): { pageUrls: string[]; childSitemaps: string[] }` exported from `src/crawl/sitemap.ts`; `headerNoindex(page: CrawledPage): boolean` exported from `src/checks/seo/meta-tags.ts`; `CATEGORY_IDS` const + derived `CategoryId` from `src/types.ts` — Tasks 2–3 consume the first two.

- [ ] **Step 1 (ride-along a): harden links.ts finalUrl index.** In the `pageByUrl` construction, change the finalUrl line to normalize the key (import `normalizePageUrl` from `../../crawl/url.js`):

```ts
const finalKey = normalizePageUrl(stored.finalUrl) ?? stored.finalUrl;
if (!pageByUrl.has(finalKey)) pageByUrl.set(finalKey, stored);
```

Add a regression test to `tests/check-links.test.ts`: a page stored with `finalUrl: "https://example.com/x#landing"` (redirect Location carried a fragment) and another page linking `<a href="/x">` → no findings, score 100.

- [ ] **Step 2 (ride-along b): flag multiple meta descriptions.** In `src/checks/seo/meta-tags.ts` `pageFindings`, the description block becomes:

```ts
if (meta.descriptions.length === 0 || (meta.descriptions[0] ?? "").trim() === "") {
  add(
    "error",
    "Page has no meta description (or it is empty).",
    "Add a unique meta description of 50–160 characters.",
  );
} else if (meta.descriptions.length > 1) {
  add(
    "error",
    `Page has ${String(meta.descriptions.length)} meta description tags.`,
    "Keep exactly one meta description per page.",
  );
} else {
  /* existing length-warning logic unchanged */
}
```

Test: page with two `<meta name="description">` tags → error mentioning "2 meta description".

- [ ] **Step 3 (ride-along c): normalize noindexAllow entries.** In `noindexAllowlist`, map entries through `normalizePageUrl` (import from `../../crawl/url.js`):

```ts
return new Set(
  raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizePageUrl(entry) ?? entry),
);
```

Test: `noindexAllow: ["https://example.com/hidden#frag"]` still exempts the page stored as `https://example.com/hidden`.

- [ ] **Step 4 (ride-along d): single-source CategoryId.** In `src/types.ts`:

```ts
export const CATEGORY_IDS = [
  "functionality",
  "performance",
  "accessibility",
  "seo",
  "security",
  "content",
  "operations",
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];
```

In `src/report/schema.ts`, replace the inline category enum with `id: z.enum(CATEGORY_IDS)` (import `CATEGORY_IDS` from `../types.js`). All existing schema tests must pass unchanged.

- [ ] **Step 5 (ride-along e): exports.** Add `export` to `parseSitemapXml` in `src/crawl/sitemap.ts` and to `headerNoindex` in `src/checks/seo/meta-tags.ts`. No other changes.

- [ ] **Step 6: verify and commit**

Run: `npm run format && npm run verify` — Expected: green (existing tests all pass; the two new tests pass).

```bash
git add -A
git commit -m "refactor: backlog cleanups — finalUrl index hardening, multi-description flagging, noindexAllow normalization, CategoryId single-sourcing, exports"
```

---

### Task 2: robots.txt parser

**Files:**

- Create: `src/checks/seo/robots.ts`
- Test: `tests/robots.test.ts`

**Interfaces:**

- Produces: `interface RobotsTxt { wildcardDisallows: string[]; wildcardAllows: string[]; sitemaps: string[] }`, `parseRobotsTxt(text: string): RobotsTxt`, `isDisallowed(url: string, robots: RobotsTxt): boolean` — Task 3 consumes all three.

- [ ] **Step 1: Write the failing test** — `tests/robots.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { isDisallowed, parseRobotsTxt } from "../src/checks/seo/robots.js";

describe("parseRobotsTxt", () => {
  it("collects disallow/allow rules from the wildcard group and sitemap lines", () => {
    const robots = parseRobotsTxt(`# comment
User-agent: googlebot
Disallow: /google-only

User-agent: *
Disallow: /private
Allow: /private/ok
Crawl-delay: 1

Sitemap: https://example.com/sitemap.xml
`);
    expect(robots).toEqual({
      wildcardDisallows: ["/private"],
      wildcardAllows: ["/private/ok"],
      sitemaps: ["https://example.com/sitemap.xml"],
    });
  });

  it("handles multiple user-agents sharing one group and empty disallow", () => {
    const robots = parseRobotsTxt(`User-agent: googlebot
User-agent: *
Disallow:
Disallow: /admin
`);
    expect(robots.wildcardDisallows).toEqual(["/admin"]);
  });

  it("ends the wildcard group when a new group starts after directives", () => {
    const robots = parseRobotsTxt(`User-agent: *
Disallow: /a

User-agent: googlebot
Disallow: /b
`);
    expect(robots.wildcardDisallows).toEqual(["/a"]);
  });

  it("returns empty structures for junk input", () => {
    expect(parseRobotsTxt("%%%\nnot robots at all")).toEqual({
      wildcardDisallows: [],
      wildcardAllows: [],
      sitemaps: [],
    });
  });
});

describe("isDisallowed", () => {
  const robots = parseRobotsTxt(`User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /wild*card
`);
  it("prefix-matches literal disallow rules", () => {
    expect(isDisallowed("https://example.com/private/page", robots)).toBe(true);
    expect(isDisallowed("https://example.com/public", robots)).toBe(false);
  });
  it("applies longest-match allow precedence", () => {
    expect(isDisallowed("https://example.com/private/public/page", robots)).toBe(false);
  });
  it("skips wildcard patterns conservatively", () => {
    expect(isDisallowed("https://example.com/wildXcard", robots)).toBe(false);
  });
  it("treats blanket Disallow: / as blocking everything", () => {
    const blanket = parseRobotsTxt("User-agent: *\nDisallow: /\n");
    expect(isDisallowed("https://example.com/", blanket)).toBe(true);
    expect(isDisallowed("https://example.com/anything", blanket)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/robots.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/seo/robots.ts`**

```ts
export interface RobotsTxt {
  /** literal + wildcard Disallow patterns from the `User-agent: *` group */
  wildcardDisallows: string[];
  /** literal + wildcard Allow patterns from the `User-agent: *` group */
  wildcardAllows: string[];
  /** every Sitemap: line, any group */
  sitemaps: string[];
}

/**
 * Minimal robots.txt parser: tracks only the wildcard (*) user-agent group's
 * Disallow/Allow rules plus global Sitemap lines. Group boundaries follow the
 * standard: consecutive User-agent lines share a group; a User-agent line
 * after directives starts a new group.
 */
export function parseRobotsTxt(text: string): RobotsTxt {
  const robots: RobotsTxt = { wildcardDisallows: [], wildcardAllows: [], sitemaps: [] };
  let inWildcardGroup = false;
  let groupHadDirectives = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (groupHadDirectives) {
        inWildcardGroup = false;
        groupHadDirectives = false;
      }
      if (value === "*") inWildcardGroup = true;
    } else if (field === "sitemap") {
      if (value !== "") robots.sitemaps.push(value);
    } else if (field === "disallow" || field === "allow" || field === "crawl-delay") {
      groupHadDirectives = true;
      if (!inWildcardGroup || value === "") continue;
      if (field === "disallow") robots.wildcardDisallows.push(value);
      else if (field === "allow") robots.wildcardAllows.push(value);
    }
  }
  return robots;
}

const isLiteral = (pattern: string): boolean => !pattern.includes("*") && !pattern.endsWith("$");

/**
 * True when the URL's path is blocked for `User-agent: *`. Only literal
 * (wildcard-free) patterns are evaluated, with Google's longest-match
 * precedence between Allow and Disallow; wildcard patterns never match
 * (conservative — no false positives).
 */
export function isDisallowed(url: string, robots: RobotsTxt): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const path = target.pathname + target.search;
  const longest = (patterns: string[]): number =>
    patterns.reduce(
      (best, pattern) =>
        isLiteral(pattern) && path.startsWith(pattern) && pattern.length > best
          ? pattern.length
          : best,
      0,
    );
  const disallow = longest(robots.wildcardDisallows);
  if (disallow === 0) return false;
  return disallow > longest(robots.wildcardAllows);
}
```

- [ ] **Step 4: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/robots.test.ts` — Expected: PASS (8 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/checks/seo/robots.ts tests/robots.test.ts
git commit -m "feat: add minimal robots.txt parser with wildcard-group matching"
```

---

### Task 3: sitemapRobotsCheck

**Files:**

- Create: `src/checks/seo/sitemap-robots.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-sitemap-robots.test.ts`

**Interfaces:**

- Consumes: `parseRobotsTxt`/`isDisallowed` (Task 2); `parseSitemapXml`, `headerNoindex` (Task 1 exports); `extractPageMeta`, `normalizePageUrl`, `allowedOriginsFor`, `ctx.pages`, `ctx.fetch`.
- Produces: `sitemapRobotsCheck: Check` (id `seo.sitemap-robots`) registered in `builtinChecks` (append after `metaTagsCheck`).

- [ ] **Step 1: Write the failing test** — `tests/check-sitemap-robots.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { sitemapRobotsCheck } from "../src/checks/seo/sitemap-robots.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const sitemapXml = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;

const routesFetch =
  (routes: Record<string, { status: number; body?: string }>) =>
  (url: string): Promise<FetchResult> => {
    const route = routes[url] ?? { status: 404 };
    return Promise.resolve({
      url,
      status: route.status,
      ok: route.status < 300,
      headers: { "content-type": "application/xml" },
      body: route.body ?? "",
      redirected: false,
      durationMs: 1,
    });
  };

const goodBody = `<html lang="en"><head><title>t</title></head><body></body></html>`;

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  routes: Record<string, { status: number; body?: string }>,
  environment: Environment = "production",
  stats: Parameters<typeof fixturePageStore>[1] = {},
): CheckContext => ({
  baseUrl: "https://example.com",
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    requestHeaders: {},
    checks: {},
    customChecks: [],
  },
  pages: fixturePageStore(pages, stats),
  fetch: routesFetch(routes),
  logger: { debug: () => undefined },
});

const ROBOTS = "https://example.com/robots.txt";
const SITEMAP = "https://example.com/sitemap.xml";

describe("seo.sitemap-robots", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("seo.sitemap-robots");
  });

  it("passes a healthy site with a complete sitemap and sane robots", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: goodBody },
          { url: "https://example.com/about", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/", "https://example.com/about"]),
          },
          [ROBOTS]: { status: 200, body: `User-agent: *\nDisallow:\n\nSitemap: ${SITEMAP}\n` },
        },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns when sitemap and robots are missing, and skips the reference check", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {}),
    );
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings.every((finding) => finding.severity === "warning")).toBe(true);
    expect(outcome.score).toBe(90); // two warnings, deduction model
  });

  it("errors on entries that 404, are noindexed, or are robots-disallowed", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: goodBody },
          { url: "https://example.com/gone", status: 404, ok: false, body: goodBody },
          {
            url: "https://example.com/hidden",
            body: `<html lang="en"><head><title>t</title><meta name="robots" content="noindex"></head><body></body></html>`,
          },
          { url: "https://example.com/private/page", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml([
              "https://example.com/",
              "https://example.com/gone",
              "https://example.com/hidden",
              "https://example.com/private/page",
            ]),
          },
          [ROBOTS]: {
            status: 200,
            body: `User-agent: *\nDisallow: /private\n\nSitemap: ${SITEMAP}\n`,
          },
        },
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    const messages = errors.map((finding) => finding.message).join(" ");
    expect(messages).toContain("404");
    expect(messages).toContain("noindex");
    expect(messages).toContain("disallow");
    expect(errors.map((finding) => finding.url)).toEqual([
      "https://example.com/gone",
      "https://example.com/hidden",
      "https://example.com/private/page",
    ]);
  });

  it("warns on redirecting and cross-origin entries and pages missing from the sitemap", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/old",
            finalUrl: "https://example.com/new",
            redirected: true,
            body: goodBody,
          },
          { url: "https://example.com/new", body: goodBody },
          { url: "https://example.com/orphan", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/old", "https://elsewhere.invalid/x"]),
          },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
      ),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    const messages = warnings.map((finding) => finding.message).join(" ");
    expect(messages).toContain("redirect");
    expect(messages).toContain("cross-origin");
    const missing = warnings.filter((finding) =>
      finding.message.includes("missing from the sitemap"),
    );
    expect(missing.map((finding) => finding.url).sort()).toEqual([
      "https://example.com/new",
      "https://example.com/orphan",
    ]);
  });

  it("treats an empty/unparseable 200 sitemap as an error", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: "%%% not xml %%%" },
      }),
    );
    expect(
      outcome.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("no URLs"),
      ),
    ).toBe(true);
  });

  it("escalates a blanket robots block to error in production and warning in ci", async () => {
    const routes = {
      [ROBOTS]: { status: 200, body: "User-agent: *\nDisallow: /\n" },
    };
    const production = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], routes, "production"),
    );
    expect(
      production.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("blocks"),
      ),
    ).toBe(true);
    const ci = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], routes, "ci"),
    );
    expect(ci.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("warns when robots.txt does not reference an existing sitemap", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/"]) },
        [ROBOTS]: { status: 200, body: "User-agent: *\nDisallow:\n" },
      }),
    );
    expect(
      outcome.findings.some(
        (finding) => finding.severity === "warning" && finding.message.includes("reference"),
      ),
    ).toBe(true);
  });

  it("skips entry validation for un-stored entries when the crawl was capped", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: goodBody }],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/", "https://example.com/beyond-cap"]),
          },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
        "production",
        { capped: true },
      ),
    );
    expect(outcome.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });
});
```

(Remove the unused `textResult` helper if the linter flags it — it exists only if needed; prefer deleting it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check-sitemap-robots.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/seo/sitemap-robots.ts`**

```ts
import { allowedOriginsFor } from "../../crawl/crawler.js";
import { parseSitemapXml } from "../../crawl/sitemap.js";
import { normalizePageUrl } from "../../crawl/url.js";
import type { Check, Finding, RateLimitedFetch } from "../../types.js";
import { headerNoindex } from "./meta-tags.js";
import { extractPageMeta } from "./page-meta.js";
import { isDisallowed, parseRobotsTxt, type RobotsTxt } from "./robots.js";

const MAX_CHILD_SITEMAPS = 10;
const MAX_SITEMAP_ENTRIES = 2000;
const MISSING_FROM_SITEMAP_LIMIT = 20;
const ERROR_COST = 20;
const WARNING_COST = 5;

interface SitemapFetchResult {
  exists: boolean;
  entries: string[];
  emptyButPresent: boolean;
  failure: string | undefined;
}

async function fetchSitemapEntries(
  fetchFn: RateLimitedFetch,
  origin: string,
  allowed: ReadonlySet<string>,
): Promise<SitemapFetchResult> {
  const sitemapUrl = new URL("/sitemap.xml", origin).href;
  try {
    const response = await fetchFn(sitemapUrl);
    if (response.status !== 200) {
      return {
        exists: false,
        entries: [],
        emptyButPresent: false,
        failure: `HTTP ${String(response.status)}`,
      };
    }
    const root = parseSitemapXml(response.body);
    const entries = [...root.pageUrls];
    for (const child of root.childSitemaps.slice(0, MAX_CHILD_SITEMAPS)) {
      if (entries.length >= MAX_SITEMAP_ENTRIES) break;
      // never send requests (which carry configured auth headers) to foreign origins
      const childUrl = normalizePageUrl(child);
      if (childUrl === undefined || !allowed.has(new URL(childUrl).origin)) continue;
      try {
        const childResponse = await fetchFn(childUrl);
        if (childResponse.status === 200)
          entries.push(...parseSitemapXml(childResponse.body).pageUrls);
      } catch {
        // unreachable child sitemaps are covered by the entry-level checks
      }
    }
    return {
      exists: true,
      entries: entries.slice(0, MAX_SITEMAP_ENTRIES),
      emptyButPresent: entries.length === 0 && root.childSitemaps.length === 0,
      failure: undefined,
    };
  } catch (error) {
    return {
      exists: false,
      entries: [],
      emptyButPresent: false,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

export const sitemapRobotsCheck: Check = {
  id: "seo.sitemap-robots",
  category: "seo",
  description:
    "sitemap.xml exists and lists only live, canonical, indexable URLs; robots.txt is sane and references the sitemap.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const origin = new URL(ctx.baseUrl).origin;
    const sitemapUrl = new URL("/sitemap.xml", origin).href;
    const robotsUrl = new URL("/robots.txt", origin).href;
    const findings: Finding[] = [];
    const add = (
      severity: Finding["severity"],
      url: string,
      message: string,
      recommendation: string,
    ): void => {
      findings.push({ severity, url, message, recommendation });
    };

    let robots: RobotsTxt | undefined;
    try {
      const response = await ctx.fetch(robotsUrl);
      if (response.status === 200) robots = parseRobotsTxt(response.body);
      else
        add(
          "warning",
          robotsUrl,
          `robots.txt is missing (HTTP ${String(response.status)}).`,
          "Add a robots.txt that allows crawling and references your sitemap.",
        );
    } catch {
      add(
        "warning",
        robotsUrl,
        "robots.txt could not be fetched.",
        "Ensure /robots.txt is served.",
      );
    }

    if (robots !== undefined && isDisallowed(ctx.baseUrl, robots)) {
      add(
        ctx.environment === "production" ? "error" : "warning",
        robotsUrl,
        "robots.txt blocks the site root for all crawlers (Disallow matches the base URL).",
        "Remove the blanket Disallow before launch — search engines cannot index the site.",
      );
    }

    const allowed = allowedOriginsFor(new URL(ctx.baseUrl));
    const sitemap = await fetchSitemapEntries(ctx.fetch, origin, allowed);
    if (!sitemap.exists) {
      add(
        "warning",
        sitemapUrl,
        `sitemap.xml is missing (${sitemap.failure ?? "unknown"}).`,
        "Generate and serve a sitemap so search engines can discover every page.",
      );
    } else if (sitemap.emptyButPresent) {
      add(
        "error",
        sitemapUrl,
        "sitemap.xml contains no URLs (empty or unparseable XML).",
        "Fix the sitemap generator — an empty sitemap hides the whole site from crawlers.",
      );
    }

    if (robots !== undefined && sitemap.exists && robots.sitemaps.length === 0) {
      add(
        "warning",
        robotsUrl,
        "robots.txt does not reference the sitemap.",
        `Add "Sitemap: ${sitemapUrl}" to robots.txt.`,
      );
    }

    const capped = ctx.pages.stats().capped;
    const entrySet = new Set<string>();
    let skippedUnverifiable = 0;

    for (const raw of sitemap.entries) {
      const entry = normalizePageUrl(raw);
      if (entry === undefined) {
        add(
          "error",
          sitemapUrl,
          `Sitemap contains an invalid URL: ${raw}`,
          "Remove or fix the malformed entry.",
        );
        continue;
      }
      entrySet.add(entry);
      if (!allowed.has(new URL(entry).origin)) {
        add(
          "warning",
          entry,
          `Sitemap lists a cross-origin URL: ${entry}`,
          "A sitemap should only list URLs on its own host.",
        );
        continue;
      }
      const page = ctx.pages.get(entry);
      if (page === undefined) {
        if (capped) {
          skippedUnverifiable += 1;
          continue;
        }
        add(
          "error",
          entry,
          `Sitemap lists ${entry}, which could not be fetched during the crawl.`,
          "Remove dead URLs from the sitemap or restore the pages.",
        );
        continue;
      }
      if (page.status >= 400) {
        add(
          "error",
          entry,
          `Sitemap lists ${entry}, which returns HTTP ${String(page.status)}.`,
          "Sitemaps must only list live (200) pages — remove or fix this entry.",
        );
        continue;
      }
      if (page.redirected || page.finalUrl !== page.url) {
        add(
          "warning",
          entry,
          `Sitemap lists ${entry}, which redirects to ${page.finalUrl}.`,
          "List the final canonical URL directly instead of a redirecting one.",
        );
      } else if (page.body !== "") {
        const meta = extractPageMeta(page.body);
        if (meta.metaNoindex || headerNoindex(page)) {
          add(
            "error",
            entry,
            `Sitemap lists ${entry}, which is marked noindex.`,
            "Remove noindexed pages from the sitemap — the two signals contradict each other.",
          );
        } else if (meta.canonicals.length === 1) {
          const canonical = normalizePageUrl(meta.canonicals[0] ?? "", page.finalUrl);
          if (canonical !== undefined && canonical !== entry && canonical !== page.finalUrl) {
            add(
              "warning",
              entry,
              `Sitemap lists ${entry}, whose canonical points at ${canonical}.`,
              "List the canonical URL in the sitemap instead.",
            );
          }
        }
      }
      if (robots !== undefined && isDisallowed(entry, robots)) {
        add(
          "error",
          entry,
          `Sitemap lists ${entry}, which robots.txt disallows.`,
          "Remove the entry from the sitemap or the Disallow rule from robots.txt.",
        );
      }
    }

    if (sitemap.exists && entrySet.size > 0) {
      let missing = 0;
      for (const page of ctx.pages.htmlPages()) {
        if (page.status < 200 || page.status >= 300) continue;
        if (page.redirected || page.finalUrl !== page.url) continue;
        const meta = extractPageMeta(page.body);
        if (meta.metaNoindex || headerNoindex(page)) continue;
        const finalKey = normalizePageUrl(page.finalUrl) ?? page.finalUrl;
        if (entrySet.has(page.url) || entrySet.has(finalKey)) continue;
        missing += 1;
        if (missing <= MISSING_FROM_SITEMAP_LIMIT) {
          add(
            "warning",
            page.url,
            `Indexable page is missing from the sitemap: ${page.url}`,
            "Add the page to the sitemap (or noindex it if it should not be indexed).",
          );
        }
      }
      if (missing > MISSING_FROM_SITEMAP_LIMIT) {
        add(
          "warning",
          sitemapUrl,
          `${String(missing - MISSING_FROM_SITEMAP_LIMIT)} more indexable pages are missing from the sitemap.`,
          "Regenerate the sitemap from the full page inventory.",
        );
      }
    }

    if (skippedUnverifiable > 0) {
      ctx.logger.debug("Sitemap entries skipped as unverifiable (crawl capped)", {
        count: skippedUnverifiable,
      });
    }
    ctx.logger.debug("Sitemap/robots summary", {
      entries: sitemap.entries.length,
      findings: findings.length,
    });

    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return {
      score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings),
      findings,
    };
  },
};
```

- [ ] **Step 4: Register it** — in `src/engine/registry.ts`, import `sitemapRobotsCheck` from `../checks/seo/sitemap-robots.js` and append after `metaTagsCheck`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/check-sitemap-robots.test.ts` — Expected: PASS (9 tests). Then `npx vitest run` — existing run-review integration fixtures now also run this check; their servers 404 both /robots.txt and /sitemap.xml → two warnings, score 90, status "warn" — which does NOT change any existing grade assertion (warn ≠ fail, blocking untripped). Investigate root-cause if anything fails.

- [ ] **Step 6: Full verify and commit**

Run: `npm run format && npm run verify` — Expected: green.

```bash
git add src/checks/seo/sitemap-robots.ts src/engine/registry.ts tests/check-sitemap-robots.test.ts
git commit -m "feat: add seo.sitemap-robots check validating sitemap entries and robots.txt"
```

---

### Task 4: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Integration test** — append to `tests/run-review.test.ts`:

```ts
it("surfaces sitemap and robots issues from a live crawl", async () => {
  server = await startServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nDisallow: /secret\n");
      return;
    }
    if (req.url === "/sitemap.xml") {
      res.setHeader("content-type", "application/xml");
      res.end(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${server?.url ?? ""}/secret/page</loc></url></urlset>`,
      );
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const seo = report.categories.find((category) => category.id === "seo");
  const check = seo?.checks.find((entry) => entry.id === "seo.sitemap-robots");
  expect(check?.status).toBe("fail");
  expect(
    check?.findings.some(
      (finding) => finding.severity === "error" && finding.message.includes("disallow"),
    ),
  ).toBe(true);
});
```

Run: `npx vitest run tests/run-review.test.ts` — Expected: PASS. (The sitemap-seeded `/secret/page` is crawled (robots.txt does not bind our crawler — we are the site owner's tool), stored 200, and flagged because robots disallows it while the sitemap lists it.)

- [ ] **Step 2: README** — add a checks-table row after `seo.meta-tags`:

```markdown
| `seo.sitemap-robots` | sitemap.xml exists and lists only live, canonical, indexable, robots-allowed URLs; crawled pages appear in it; robots.txt is sane and references the sitemap |
```

- [ ] **Step 3: Full verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: local fixture site with a robots-disallowed sitemap entry via `node dist/cli.js <url> --env ci --format console`.

```bash
git add -A
git commit -m "feat: document sitemap-robots check and add integration coverage"
git push -u origin feat/sitemap-robots
gh pr create --base main --title "feat: seo.sitemap-robots check (PR 6)" --body "PR 6 of the roadmap: sitemap.xml validity (entries must be live/canonical/indexable/robots-allowed, cross-origin and redirecting entries flagged), completeness cross-check against the crawl, robots.txt sanity (blanket-block detection, sitemap reference), minimal hand-rolled robots parser (no new dependency). Includes five backlog ride-alongs (finalUrl index hardening, multi-description flagging, noindexAllow normalization, CategoryId single-sourcing, parser exports). No report schema change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...` instead.)

---

## After this plan

PR 7 (`security.headers` + `security.tls`) begins the security category. Remaining ledger backlog after this PR: hasAnchorTarget double pass, probe-handling dedupe, config loader no-default-export guard, runner test timer hygiene, reachable 3xx wording, srcset sibling under-checking, crawl-skip when all checks disabled.
