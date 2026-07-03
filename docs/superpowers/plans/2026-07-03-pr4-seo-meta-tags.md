# Site Reviewer PR 4 (seo.meta-tags) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `seo.meta-tags` check — per-page title/description/canonical/h1/lang validation, site-wide title/description uniqueness, and the environment-aware noindex guard — the first check that exercises the whole crawl.

**Architecture:** A pure cheerio extractor (`extractPageMeta`) feeds a check that iterates `ctx.pages.htmlPages()` (2xx only), emits per-page findings, then cross-page uniqueness findings, then noindex findings whose severity depends on `ctx.environment` (local: ignored; ci: warning; production: error). Score = share of scanned pages with no error-severity finding. Two small PR 3 backlog cleanups ride along in Task 1.

**Tech Stack:** cheerio (already a dependency), fixturePageStore test helper, existing Check interface.

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`.
- No `eval` / `new Function` / `child_process` in `src/`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- Report schema is UNCHANGED in this PR (no `REPORT_VERSION` bump).
- Check id `seo.meta-tags`, category `seo`, `blocking: true` (per the design spec's sample report), `weight: 1`, environments `["local", "ci", "production"]`.
- Thresholds (constants, spec §11): title ≤ 60 chars; description 50–160 chars.
- noindex guard by environment: `local` → not evaluated; `ci` → warning; `production` → error. Detected from BOTH `<meta name="robots">` content containing `noindex`/`none` AND the `X-Robots-Tag` response header containing `noindex`. Per-page opt-out via check options `noindexAllow: string[]` (normalized page URLs).
- Conventional commits. Branch: `feat/seo-meta-tags`, PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/checks/seo/page-meta.ts   extractPageMeta(html): PageMeta — pure parser
src/checks/seo/meta-tags.ts   metaTagsCheck — findings + scoring
src/engine/registry.ts        register metaTagsCheck
src/crawl/crawler.ts          (ride-along) isHtml helper dedupe
src/crawl/sitemap.ts          (ride-along) fix stale "only same-origin" JSDoc
README.md                     document check options (noindexAllow)
```

---

### Task 1: Page-meta extractor + PR 3 backlog ride-alongs

**Files:**

- Create: `src/checks/seo/page-meta.ts`
- Modify: `src/crawl/crawler.ts` (isHtml dedupe), `src/crawl/sitemap.ts` (JSDoc only)
- Test: `tests/page-meta.test.ts`

**Interfaces:**

- Produces: `extractPageMeta(html: string): PageMeta` and `interface PageMeta { titles: string[]; descriptions: string[]; canonicals: string[]; h1Count: number; lang: string | undefined; metaNoindex: boolean }` from `src/checks/seo/page-meta.ts` — Task 2 consumes both.

- [ ] **Step 1: Create branch**

```bash
git checkout main && git pull && git checkout -b feat/seo-meta-tags
```

- [ ] **Step 2: Write the failing test** — `tests/page-meta.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractPageMeta } from "../src/checks/seo/page-meta.js";

describe("extractPageMeta", () => {
  it("extracts title, description, canonical, h1 count, and lang", () => {
    const meta = extractPageMeta(`<!doctype html>
      <html lang="en"><head>
        <title>  Home  </title>
        <meta name="description" content=" Welcome to our site, the best site on the internet for sites. ">
        <link rel="canonical" href="https://example.com/">
      </head><body><h1>Hi</h1><h1>Second</h1></body></html>`);
    expect(meta).toEqual({
      titles: ["Home"],
      descriptions: ["Welcome to our site, the best site on the internet for sites."],
      canonicals: ["https://example.com/"],
      h1Count: 2,
      lang: "en",
      metaNoindex: false,
    });
  });

  it("reports missing elements as empty/undefined", () => {
    const meta = extractPageMeta("<html><head></head><body><p>bare</p></body></html>");
    expect(meta).toEqual({
      titles: [],
      descriptions: [],
      canonicals: [],
      h1Count: 0,
      lang: undefined,
      metaNoindex: false,
    });
  });

  it("collects duplicate titles and matches attributes case-insensitively", () => {
    const meta = extractPageMeta(`<html lang="en"><head>
      <title>One</title><title>Two</title>
      <META NAME="Description" CONTENT="desc">
      <link REL="Canonical" href="/x">
    </head><body></body></html>`);
    expect(meta.titles).toEqual(["One", "Two"]);
    expect(meta.descriptions).toEqual(["desc"]);
    expect(meta.canonicals).toEqual(["/x"]);
  });

  it("detects noindex and none in robots meta, case-insensitively", () => {
    const noindex = extractPageMeta(
      `<html><head><meta name="robots" content="NOINDEX, follow"></head><body></body></html>`,
    );
    expect(noindex.metaNoindex).toBe(true);
    const none = extractPageMeta(
      `<html><head><meta name="robots" content="none"></head><body></body></html>`,
    );
    expect(none.metaNoindex).toBe(true);
    const indexable = extractPageMeta(
      `<html><head><meta name="robots" content="index, nofollow"></head><body></body></html>`,
    );
    expect(indexable.metaNoindex).toBe(false);
  });

  it("treats an empty lang attribute as missing", () => {
    expect(extractPageMeta(`<html lang=""><head></head></html>`).lang).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/page-meta.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Write `src/checks/seo/page-meta.ts`**

```ts
import { load } from "cheerio";

export interface PageMeta {
  titles: string[];
  descriptions: string[];
  canonicals: string[];
  h1Count: number;
  lang: string | undefined;
  /** true when a robots meta tag declares noindex (or none) */
  metaNoindex: boolean;
}

/** Extract the SEO-relevant head/body facts from one HTML document. */
export function extractPageMeta(html: string): PageMeta {
  const $ = load(html);
  const titles = $("head > title")
    .map((_index, element) => $(element).text().trim())
    .get();
  const descriptions = $('head meta[name="description" i]')
    .map((_index, element) => ($(element).attr("content") ?? "").trim())
    .get();
  const canonicals = $('head link[rel="canonical" i]')
    .map((_index, element) => ($(element).attr("href") ?? "").trim())
    .get();
  const robotsDirectives = $('head meta[name="robots" i]')
    .map((_index, element) => ($(element).attr("content") ?? "").toLowerCase())
    .get()
    .join(",")
    .split(",")
    .map((directive) => directive.trim());
  const lang = $("html").attr("lang")?.trim();
  return {
    titles,
    descriptions,
    canonicals,
    h1Count: $("h1").length,
    lang: lang === "" || lang === undefined ? undefined : lang,
    metaNoindex: robotsDirectives.includes("noindex") || robotsDirectives.includes("none"),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/page-meta.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 6: Ride-along cleanups (separate commit)**

In `src/crawl/crawler.ts`: the expression `(… .headers["content-type"] ?? "").includes("text/html")` appears twice (in `SitePageStore.htmlPages()` and in `visit()`). Add one module-level helper and use it in both places:

```ts
function isHtmlContentType(headers: Record<string, string>): boolean {
  return (headers["content-type"] ?? "").includes("text/html");
}
```

In `src/crawl/sitemap.ts`: the `fetchSitemapUrls` JSDoc still says "Only same-origin page URLs are returned" — stale since the `allowedOrigins` parameter landed. Change that sentence to: "Only page URLs within the allowed origins (default: the sitemap's own origin) are returned."

Run: `npx vitest run tests/crawler.test.ts tests/sitemap.test.ts` — Expected: PASS (behavior unchanged).

- [ ] **Step 7: Full verify and commit**

Run: `npm run format && npm run verify` — Expected: green.

```bash
git add src/checks/seo/page-meta.ts tests/page-meta.test.ts
git commit -m "feat: add SEO page-meta extractor"
git add src/crawl/crawler.ts src/crawl/sitemap.ts
git commit -m "refactor: dedupe HTML content-type check and fix stale sitemap doc"
```

---

### Task 2: metaTagsCheck — per-page findings, uniqueness, noindex guard, scoring

**Files:**

- Create: `src/checks/seo/meta-tags.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-meta-tags.test.ts`

**Interfaces:**

- Consumes: `extractPageMeta`/`PageMeta` (Task 1); `CheckContext.pages.htmlPages()`; `fixturePageStore` (tests).
- Produces: `metaTagsCheck: Check` (id `seo.meta-tags`) registered in `builtinChecks`.

Finding rules (severity — message must name the page URL via the finding's `url` field):

- Per page: no title → **error**; multiple titles → **error**; title > 60 chars → **warning**; no description → **error**; description outside 50–160 chars → **warning**; multiple canonicals → **error**; no canonical → **warning**; `h1Count === 0` or `> 1` → **warning**; missing `lang` → **error**.
- Site-wide: same non-empty title on 2+ pages → one **error** per extra page (message names the first page that used it); same non-empty description on 2+ pages → one **warning** per extra page.
- noindex (meta OR `x-robots-tag` header containing `noindex`), unless the page's normalized URL is in the `noindexAllow` option: `production` → **error**, `ci` → **warning**, `local` → not evaluated.
- Scoring: pages checked = `htmlPages()` with `status` in 200–299. `score = pages ? Math.round((100 * pagesWithNoErrorFinding) / pages) : 100`. Zero pages → `{ score: 100, findings: [] }`.

- [ ] **Step 1: Write the failing test** — `tests/check-meta-tags.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { metaTagsCheck } from "../src/checks/seo/meta-tags.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, ResolvedConfig, Severity } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const goodPage = (
  title: string,
  description = "A perfectly reasonable description that sits comfortably within the limits.",
) => `
  <html lang="en"><head>
    <title>${title}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="https://example.com/">
  </head><body><h1>${title}</h1></body></html>`;

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  environment: Environment = "production",
  checks: ResolvedConfig["checks"] = {},
): CheckContext => ({
  baseUrl: "https://example.com",
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    requestHeaders: {},
    checks,
    customChecks: [],
  },
  pages: fixturePageStore(pages),
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  logger: { debug: () => undefined },
});

const findingsBySeverity = (findings: { severity: Severity }[], severity: Severity) =>
  findings.filter((finding) => finding.severity === severity);

describe("seo.meta-tags", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("seo.meta-tags");
  });

  it("passes a clean multi-page site with score 100", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        { url: "https://example.com/", body: goodPage("Home") },
        { url: "https://example.com/about", body: goodPage("About") },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags missing title, description, and lang as errors on the offending page", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        { url: "https://example.com/", body: goodPage("Home") },
        { url: "https://example.com/bad", body: "<html><head></head><body></body></html>" },
      ]),
    );
    const errors = findingsBySeverity(outcome.findings, "error");
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.every((finding) => finding.url === "https://example.com/bad")).toBe(true);
    expect(outcome.score).toBe(50); // 1 of 2 pages clean
    expect(errors.every((finding) => finding.recommendation !== "")).toBe(true);
  });

  it("warns on long titles, out-of-range descriptions, missing canonical, and h1 count", async () => {
    const longTitle = "T".repeat(61);
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: `<html lang="en"><head><title>${longTitle}</title><meta name="description" content="short"></head><body></body></html>`,
        },
      ]),
    );
    const warnings = findingsBySeverity(outcome.findings, "warning");
    expect(warnings.map((finding) => finding.message.toLowerCase()).join(" ")).toContain("60");
    expect(warnings.length).toBeGreaterThanOrEqual(4); // title length, description length, canonical, h1
    expect(outcome.score).toBe(100); // warnings do not reduce the score
  });

  it("flags duplicate titles as errors and duplicate descriptions as warnings", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        { url: "https://example.com/", body: goodPage("Same Title") },
        { url: "https://example.com/copy", body: goodPage("Same Title") },
      ]),
    );
    const duplicateTitle = findingsBySeverity(outcome.findings, "error").find((finding) =>
      finding.message.includes("Same Title"),
    );
    expect(duplicateTitle?.url).toBe("https://example.com/copy");
    expect(duplicateTitle?.message).toContain("https://example.com/");
    expect(
      findingsBySeverity(outcome.findings, "warning").some((finding) =>
        finding.message.toLowerCase().includes("description"),
      ),
    ).toBe(true);
  });

  it("treats noindex as an error in production, a warning in ci, and ignores it locally", async () => {
    const noindexPage = {
      url: "https://example.com/",
      body: `<html lang="en"><head><title>Home</title><meta name="description" content="A perfectly reasonable description that sits comfortably within the limits."><link rel="canonical" href="/"><meta name="robots" content="noindex"></head><body><h1>x</h1></body></html>`,
    };
    const production = await metaTagsCheck.run(contextFor([noindexPage], "production"));
    expect(
      findingsBySeverity(production.findings, "error").some((f) => f.message.includes("noindex")),
    ).toBe(true);
    const ci = await metaTagsCheck.run(contextFor([noindexPage], "ci"));
    expect(
      findingsBySeverity(ci.findings, "warning").some((f) => f.message.includes("noindex")),
    ).toBe(true);
    expect(findingsBySeverity(ci.findings, "error")).toEqual([]);
    const local = await metaTagsCheck.run(contextFor([noindexPage], "local"));
    expect(local.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("detects noindex from the X-Robots-Tag header and honors the noindexAllow option", async () => {
    const page = {
      url: "https://example.com/hidden",
      body: goodPage("Hidden"),
      headers: { "content-type": "text/html", "x-robots-tag": "noindex, nofollow" },
    };
    const flagged = await metaTagsCheck.run(contextFor([page], "production"));
    expect(flagged.findings.some((f) => f.message.includes("noindex"))).toBe(true);
    const allowed = await metaTagsCheck.run(
      contextFor([page], "production", {
        "seo.meta-tags": { options: { noindexAllow: ["https://example.com/hidden"] } },
      }),
    );
    expect(allowed.findings.some((f) => f.message.includes("noindex"))).toBe(false);
  });

  it("only evaluates 2xx HTML pages and returns 100 for an empty store", async () => {
    const outcome = await metaTagsCheck.run(
      contextFor([
        {
          url: "https://example.com/gone",
          body: "<html><head></head></html>",
          status: 404,
          ok: false,
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check-meta-tags.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/seo/meta-tags.ts`**

```ts
import type { Check, CheckContext, CrawledPage, Finding } from "../../types.js";
import { extractPageMeta } from "./page-meta.js";

const TITLE_MAX_LENGTH = 60;
const DESCRIPTION_MIN_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 160;

function noindexAllowlist(ctx: CheckContext): Set<string> {
  const raw = ctx.config.checks["seo.meta-tags"]?.options?.["noindexAllow"];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((entry): entry is string => typeof entry === "string"));
}

function headerNoindex(page: CrawledPage): boolean {
  return (page.headers["x-robots-tag"] ?? "").toLowerCase().includes("noindex");
}

function pageFindings(page: CrawledPage, meta: ReturnType<typeof extractPageMeta>): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], message: string, recommendation: string): void => {
    findings.push({ severity, message, recommendation, url: page.url });
  };

  if (meta.titles.length === 0) {
    add("error", "Page has no <title>.", "Add a unique, descriptive title under 60 characters.");
  } else if (meta.titles.length > 1) {
    add(
      "error",
      `Page has ${String(meta.titles.length)} <title> tags.`,
      "Keep exactly one <title> per page.",
    );
  } else if ((meta.titles[0] ?? "").length > TITLE_MAX_LENGTH) {
    add(
      "warning",
      `Title is ${String((meta.titles[0] ?? "").length)} characters (recommended max ${String(TITLE_MAX_LENGTH)}).`,
      "Shorten the title so search results do not truncate it.",
    );
  }

  if (meta.descriptions.length === 0) {
    add(
      "error",
      "Page has no meta description.",
      "Add a unique meta description of 50–160 characters.",
    );
  } else {
    const length = (meta.descriptions[0] ?? "").length;
    if (length < DESCRIPTION_MIN_LENGTH || length > DESCRIPTION_MAX_LENGTH) {
      add(
        "warning",
        `Meta description is ${String(length)} characters (recommended ${String(DESCRIPTION_MIN_LENGTH)}–${String(DESCRIPTION_MAX_LENGTH)}).`,
        "Rewrite the description to a compelling 50–160 character summary.",
      );
    }
  }

  if (meta.canonicals.length === 0) {
    add(
      "warning",
      "Page has no rel=canonical link.",
      "Add a self-referencing canonical URL unless this page intentionally canonicalizes elsewhere.",
    );
  } else if (meta.canonicals.length > 1) {
    add(
      "error",
      `Page has ${String(meta.canonicals.length)} canonical links.`,
      "Keep exactly one rel=canonical per page.",
    );
  }

  if (meta.h1Count === 0) {
    add("warning", "Page has no <h1>.", "Add a single <h1> describing the page's main topic.");
  } else if (meta.h1Count > 1) {
    add(
      "warning",
      `Page has ${String(meta.h1Count)} <h1> elements.`,
      "Use one <h1> per page; demote the others to <h2>.",
    );
  }

  if (meta.lang === undefined) {
    add(
      "error",
      "The <html> element has no lang attribute.",
      'Add lang (e.g. <html lang="en">) so assistive technology and search engines know the language.',
    );
  }

  return findings;
}

export const metaTagsCheck: Check = {
  id: "seo.meta-tags",
  category: "seo",
  description:
    "Every page has exactly one good title, meta description, canonical, h1, and lang; titles are unique site-wide; no stray noindex.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  run(ctx) {
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    ctx.logger.debug("Evaluating meta tags", { pagesChecked: pages.length });
    if (pages.length === 0) return Promise.resolve({ score: 100, findings: [] });

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    const allow = noindexAllowlist(ctx);
    const firstTitleUse = new Map<string, string>();
    const firstDescriptionUse = new Map<string, string>();

    for (const page of pages) {
      const meta = extractPageMeta(page.body);
      for (const finding of pageFindings(page, meta)) record(finding);

      const title = meta.titles.length === 1 ? (meta.titles[0] ?? "") : "";
      if (title !== "") {
        const firstUse = firstTitleUse.get(title);
        if (firstUse === undefined) firstTitleUse.set(title, page.url);
        else
          record({
            severity: "error",
            url: page.url,
            message: `Duplicate <title> "${title}" — already used on ${firstUse}.`,
            recommendation: "Give each page a unique title under 60 characters.",
          });
      }

      const description = meta.descriptions[0] ?? "";
      if (description !== "") {
        const firstUse = firstDescriptionUse.get(description);
        if (firstUse === undefined) firstDescriptionUse.set(description, page.url);
        else
          record({
            severity: "warning",
            url: page.url,
            message: `Duplicate meta description — already used on ${firstUse}.`,
            recommendation: "Write a unique meta description for each page.",
          });
      }

      if (ctx.environment !== "local" && !allow.has(page.url)) {
        if (meta.metaNoindex || headerNoindex(page)) {
          record({
            severity: ctx.environment === "production" ? "error" : "warning",
            url: page.url,
            message: `Page is marked noindex (${meta.metaNoindex ? "robots meta tag" : "X-Robots-Tag header"}).`,
            recommendation:
              "Remove the noindex directive before launch, or add this URL to the seo.meta-tags noindexAllow option if it is intentional.",
          });
        }
      }
    }

    const cleanPages = pages.length - pagesWithErrors.size;
    return Promise.resolve({
      score: Math.round((100 * cleanPages) / pages.length),
      findings,
    });
  },
};
```

- [ ] **Step 4: Register it** — in `src/engine/registry.ts` add the import and append `metaTagsCheck` to `builtinChecks`:

```ts
import { metaTagsCheck } from "../checks/seo/meta-tags.js";
```

```ts
export const builtinChecks: Check[] = [reachableCheck, crawlCoverageCheck, metaTagsCheck];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/check-meta-tags.test.ts` — Expected: PASS (8 tests). Then `npx vitest run` — if any existing run-review/CLI test assumed specific check sets, investigate root-cause before touching them (they tolerated the Task 6 addition in PR 3, so they should tolerate this one; note the run-review fixture servers return bodies without `content-type: text/html`, so `htmlPages()` excludes them and this check scores 100 there).

- [ ] **Step 6: Full verify and commit**

Run: `npm run format && npm run verify` — Expected: green.

```bash
git add src/checks/seo/meta-tags.ts src/engine/registry.ts tests/check-meta-tags.test.ts
git commit -m "feat: add seo.meta-tags check with site-wide uniqueness and noindex guard"
```

---

### Task 3: README, integration smoke, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts` (one integration case)

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Add an integration test** — in `tests/run-review.test.ts`, add:

```ts
it("surfaces seo.meta-tags findings from crawled pages", async () => {
  server = await startServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/") {
      res.end(
        '<html lang="en"><head><title>Home</title><meta name="description" content="A perfectly reasonable description that sits comfortably within the limits."><link rel="canonical" href="/"></head><body><h1>Hi</h1><a href="/bare">bare</a></body></html>',
      );
    } else {
      res.end("<html><head></head><body>no meta at all</body></html>");
    }
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const seo = report.categories.find((category) => category.id === "seo");
  const check = seo?.checks.find((entry) => entry.id === "seo.meta-tags");
  expect(check?.status).toBe("fail");
  expect(check?.findings.some((finding) => finding.url?.endsWith("/bare") ?? false)).toBe(true);
  expect(report.grade).toBe("fail"); // blocking check failed
});
```

Run: `npx vitest run tests/run-review.test.ts` — Expected: PASS (new test exercises crawl → check → report end-to-end).

- [ ] **Step 2: README** — after the Crawling section, add:

````markdown
## Checks

| id                             | what it verifies                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `functionality.reachable`      | the base URL responds successfully (no 4xx/5xx, no unfollowed off-origin redirect)                                                      |
| `functionality.crawl-coverage` | the crawl covered the site without hitting `maxPages`                                                                                   |
| `seo.meta-tags`                | one good title/description/canonical/h1/lang per page; titles unique site-wide; no stray `noindex` (error in production, warning in ci) |

Per-check options go under `checks` in the config file:

```ts
export default defineConfig({
  checks: {
    "seo.meta-tags": {
      options: { noindexAllow: ["https://example.com/internal-tool"] },
    },
  },
});
```
````

````

- [ ] **Step 3: Full verify, live smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: `npm run build && node dist/cli.js <local test server or https://example.com> --env ci --format console` — Expected: `seo.meta-tags` appears in the seo category with findings/recommendations.

```bash
git add -A
git commit -m "feat: document built-in checks and add meta-tags integration coverage"
git push -u origin feat/seo-meta-tags
gh pr create --base main --title "feat: seo.meta-tags check (PR 4)" --body "PR 4 of the roadmap: per-page title/description/canonical/h1/lang validation, site-wide title/description uniqueness, and the environment-aware noindex guard (error in production, warning in ci, ignored locally; per-URL noindexAllow opt-out). Includes two PR 3 backlog ride-alongs (isHtml dedupe, sitemap JSDoc fix). No report schema change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
````

---

## After this plan

PR 5 (`functionality.links`) also iterates `ctx.pages` and reuses `extractLinks` — internal link/anchor/asset validation, external links production-only non-blocking.
