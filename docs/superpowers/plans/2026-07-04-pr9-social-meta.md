# Site Reviewer PR 9 (seo.social-meta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `seo.social-meta` check — Open Graph / Twitter Card presence per page, `og:image` absolute-URL + actually-resolves validation — and land the shared per-page parsed-DOM cache ride-along (each page is currently cheerio-parsed 4× per run).

**Architecture:** Ride-along first: a `pageDom(page)` helper memoizes one `CheerioAPI` per `CrawledPage` via WeakMap, and the four existing extractors (`extractPageMeta`, `extractPageRefs`, `findMixedContent`, `extractJsonLd`) accept `string | CheerioAPI` so tests keep passing raw HTML while checks pass the cached handle. Then the new check: a pure `extractSocialMeta($)` reads OG/Twitter tags; the check emits per-page warnings for missing tags, probes `og:image` URLs through `ctx.fetch` (HEAD→GET-fallback, per-URL cache, external images production-only — the links-check precedent), and errors on broken same-origin images. Page-clean-ratio scoring.

**Tech Stack:** cheerio (existing; `CheerioAPI` type), PageStore. No new dependencies — pixel-dimension validation of og:image (which would need an image parser) is explicitly deferred; v1 validates absoluteness, resolution, and image content-type.

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`. Report schema UNCHANGED.
- No `eval` / `new Function` / `child_process`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- **Ride-along (performance): shared parsed-DOM cache.**
  - New `src/crawl/page-dom.ts`: `pageDom(page: CrawledPage): CheerioAPI` — WeakMap-memoized `load(page.body)`.
  - `extractPageMeta`, `extractPageRefs` (and its internal `hasAnchorTarget` stays string-based — it parses TARGET pages' bodies; convert it too: `string | CheerioAPI`), `findMixedContent`, `extractJsonLd` change their first parameter to `string | CheerioAPI`, with first line `const $ = typeof source === "string" ? load(source) : source;`. All existing tests (which pass strings) must pass UNCHANGED.
  - Checks that iterate pages (`meta-tags`, `links`, `tls` mixed-content, `structured-data`, `sitemap-robots` entry/completeness loops) switch to passing `pageDom(page)`.
  - Behavior must be byte-identical — this is a pure performance refactor; the review gate is "no test changed, no finding text changed."
- `seo.social-meta`: id `seo.social-meta`, category `seo`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`.
  - Evaluated on 2xx `htmlPages()`.
  - Tag extraction: `meta[property="og:title" i]`, `og:description`, `og:image` (also accept `og:image:url`), `og:url` (content attribute, trimmed); `meta[name="twitter:card" i]` (also accept `property=` form — some sites use it).
  - Severities (findings carry the page URL):
    - Page has ZERO og: tags → ONE **warning** ("no Open Graph tags — link shares will render poorly").
    - Page has SOME og: tags: each missing core tag among og:title / og:description / og:image / og:url → **warning** (one per missing tag).
    - `og:image` present but not an absolute http(s) URL → **warning** (platforms require absolute URLs).
    - `og:image` absolute: probed once per unique URL (HEAD, GET fallback on 405/501): same-origin broken (≥400/unreachable) → **error**; cross-origin probed ONLY in production, broken → **warning**; response content-type present but not `image/*` → **warning**.
    - `twitter:card` missing (on pages that have at least one og: tag) → **info** (platforms fall back to OG).
  - Scoring: `score = round(100 × pages-without-error-finding / pages)`; zero pages → `{ score: 100, findings: [] }`.
- Conventional commits. Branch: `feat/social-meta` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/crawl/page-dom.ts             pageDom (WeakMap cheerio cache)
src/checks/seo/page-meta.ts       (ride-along) string | CheerioAPI
src/checks/functionality/link-extract.ts  (ride-along) string | CheerioAPI (both fns)
src/checks/security/tls.ts        (ride-along) findMixedContent string | CheerioAPI
src/checks/seo/json-ld.ts         (ride-along) string | CheerioAPI
src/checks/{seo,functionality,security}/*.ts  checks pass pageDom(page)
src/checks/seo/social-meta.ts     extractSocialMeta + socialMetaCheck
src/engine/registry.ts            register socialMetaCheck
README.md                         checks table row
```

---

### Task 1: Shared parsed-DOM cache ride-along

**Files:**

- Create: `src/crawl/page-dom.ts`
- Modify: `src/checks/seo/page-meta.ts`, `src/checks/functionality/link-extract.ts`, `src/checks/security/tls.ts`, `src/checks/seo/json-ld.ts`, and their consuming checks (`meta-tags.ts`, `links.ts`, `structured-data.ts`, `sitemap-robots.ts`, `tls.ts`)
- Test: `tests/page-dom.test.ts`

**Interfaces:**

- Produces: `pageDom(page: CrawledPage): CheerioAPI` from `src/crawl/page-dom.ts`; all four extractors accept `string | CheerioAPI`.

- [ ] **Step 1: Write the failing test** — `tests/page-dom.test.ts`

```ts
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { pageDom } from "../src/crawl/page-dom.js";
import { extractPageMeta } from "../src/checks/seo/page-meta.js";
import { fixturePage } from "./helpers/page-store.js";

describe("pageDom", () => {
  it("returns the same parsed handle for repeated calls on one page", () => {
    const page = fixturePage({
      url: "https://example.com/",
      body: "<html><head><title>T</title></head></html>",
    });
    const first = pageDom(page);
    expect(pageDom(page)).toBe(first);
  });

  it("parses distinct pages independently", () => {
    const a = fixturePage({
      url: "https://example.com/a",
      body: "<html><head><title>A</title></head></html>",
    });
    const b = fixturePage({
      url: "https://example.com/b",
      body: "<html><head><title>B</title></head></html>",
    });
    expect(pageDom(a)("title").text()).toBe("A");
    expect(pageDom(b)("title").text()).toBe("B");
  });

  it("extractors accept a pre-parsed handle and agree with string input", () => {
    const html = '<html lang="en"><head><title>T</title></head><body></body></html>';
    const page = fixturePage({ url: "https://example.com/", body: html });
    expect(extractPageMeta(pageDom(page))).toEqual(extractPageMeta(html));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/page-dom.test.ts` — Expected: FAIL (module not found; extractPageMeta rejects CheerioAPI).

- [ ] **Step 3: Write `src/crawl/page-dom.ts`**

```ts
import { load, type CheerioAPI } from "cheerio";
import type { CrawledPage } from "../types.js";

const cache = new WeakMap<CrawledPage, CheerioAPI>();

/**
 * One parsed DOM per crawled page per run. Checks share the handle instead of
 * re-parsing the same HTML (previously up to 4 cheerio parses per page).
 */
export function pageDom(page: CrawledPage): CheerioAPI {
  const cached = cache.get(page);
  if (cached !== undefined) return cached;
  const parsed = load(page.body);
  cache.set(page, parsed);
  return parsed;
}
```

- [ ] **Step 4: Convert the four extractors.** Pattern for each (page-meta.ts shown; same for `extractPageRefs` + `hasAnchorTarget` in link-extract.ts, `findMixedContent` in tls.ts, `extractJsonLd` in json-ld.ts):

```ts
import { load, type CheerioAPI } from "cheerio";

export function extractPageMeta(source: string | CheerioAPI): PageMeta {
  const $ = typeof source === "string" ? load(source) : source;
  // …body unchanged, using $ …
}
```

The parameter RENAME (`html` → `source`) is the only signature change; every existing call site that passes a string keeps compiling. Behavior identical.

- [ ] **Step 5: Switch the page-iterating checks to the cache.** In `meta-tags.ts`, `links.ts` (both `extractPageRefs(page.body, page.finalUrl)` → `extractPageRefs(pageDom(page), page.finalUrl)` AND the anchor-target lookups `hasAnchorTarget(target.body, …)` → `hasAnchorTarget(pageDom(target), …)`), `structured-data.ts`, `sitemap-robots.ts` (its two `extractPageMeta(page.body)` sites), and `tls.ts` (`findMixedContent(page.body)` → `findMixedContent(pageDom(page))`). Import `pageDom` from the relative path to `../../crawl/page-dom.js`.

- [ ] **Step 6: Full verification — the gate is zero behavioral drift**

Run: `npx vitest run` — Expected: ALL existing tests pass UNCHANGED (if any existing test fails, the refactor changed behavior — root-cause, don't touch the test).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "perf: share one parsed DOM per page across checks"
```

---

### Task 2: socialMetaCheck

**Files:**

- Create: `src/checks/seo/social-meta.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-social-meta.test.ts`

**Interfaces:**

- Consumes: `pageDom` (Task 1), `allowedOriginsFor`, `ctx.pages` / `ctx.fetch`, `fixturePageStore`.
- Produces: `extractSocialMeta($: CheerioAPI): SocialMeta` (exported for tests) and `socialMetaCheck: Check` registered after `structuredDataCheck`.

Write `src/checks/seo/social-meta.ts`:

```ts
import type { CheerioAPI } from "cheerio";
import { allowedOriginsFor } from "../../crawl/crawler.js";
import { pageDom } from "../../crawl/page-dom.js";
import type { Check, CheckContext, Finding } from "../../types.js";

export interface SocialMeta {
  ogTagCount: number;
  ogTitle: string | undefined;
  ogDescription: string | undefined;
  ogImage: string | undefined;
  ogUrl: string | undefined;
  twitterCard: string | undefined;
}

const content = ($: CheerioAPI, selector: string): string | undefined => {
  const value = $(selector).first().attr("content")?.trim();
  return value === "" ? undefined : value;
};

export function extractSocialMeta($: CheerioAPI): SocialMeta {
  return {
    ogTagCount: $('meta[property^="og:" i]').length,
    ogTitle: content($, 'meta[property="og:title" i]'),
    ogDescription: content($, 'meta[property="og:description" i]'),
    ogImage:
      content($, 'meta[property="og:image" i]') ?? content($, 'meta[property="og:image:url" i]'),
    ogUrl: content($, 'meta[property="og:url" i]'),
    twitterCard:
      content($, 'meta[name="twitter:card" i]') ?? content($, 'meta[property="twitter:card" i]'),
  };
}

const isAbsoluteHttp = (value: string): boolean => /^https?:\/\//i.test(value);

type ProbeResult =
  { kind: "status"; status: number; contentType: string } | { kind: "unreachable" };

export const socialMetaCheck: Check = {
  id: "seo.social-meta",
  category: "seo",
  description:
    "Pages carry Open Graph tags for link sharing, and og:image URLs are absolute and actually resolve.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    if (pages.length === 0) return { score: 100, findings: [] };

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    const allowedOrigins = allowedOriginsFor(new URL(ctx.baseUrl));
    const probeCache = new Map<string, Promise<ProbeResult>>();
    const probe = (url: string): Promise<ProbeResult> => {
      const cached = probeCache.get(url);
      if (cached !== undefined) return cached;
      const result = (async (): Promise<ProbeResult> => {
        try {
          let response = await ctx.fetch(url, { method: "HEAD" });
          if (response.status === 405 || response.status === 501) response = await ctx.fetch(url);
          return {
            kind: "status",
            status: response.status,
            contentType: response.headers["content-type"] ?? "",
          };
        } catch {
          return { kind: "unreachable" };
        }
      })();
      probeCache.set(url, result);
      return result;
    };

    /** og:image URL → first page that referenced it, split by origin trust */
    const internalImages = new Map<string, string>();
    const externalImages = new Map<string, string>();

    for (const page of pages) {
      const meta = extractSocialMeta(pageDom(page));
      if (meta.ogTagCount === 0) {
        record({
          severity: "warning",
          url: page.url,
          message: "Page has no Open Graph tags.",
          recommendation:
            "Add og:title, og:description, og:image, and og:url so link shares render a proper preview.",
        });
        continue;
      }
      const missing: string[] = [];
      if (meta.ogTitle === undefined) missing.push("og:title");
      if (meta.ogDescription === undefined) missing.push("og:description");
      if (meta.ogImage === undefined) missing.push("og:image");
      if (meta.ogUrl === undefined) missing.push("og:url");
      for (const tag of missing) {
        record({
          severity: "warning",
          url: page.url,
          message: `Missing ${tag}.`,
          recommendation: `Add ${tag} — platforms use it directly when rendering shared links.`,
        });
      }
      if (meta.twitterCard === undefined) {
        record({
          severity: "info",
          url: page.url,
          message: "Missing twitter:card.",
          recommendation:
            'Add <meta name="twitter:card" content="summary_large_image"> for best Twitter/X rendering.',
        });
      }
      if (meta.ogImage !== undefined) {
        if (!isAbsoluteHttp(meta.ogImage)) {
          record({
            severity: "warning",
            url: page.url,
            message: `og:image is not an absolute URL: ${meta.ogImage}`,
            recommendation:
              "Use a fully-qualified https URL — platforms do not resolve relative og:image values.",
          });
        } else {
          const target = allowedOrigins.has(new URL(meta.ogImage).origin)
            ? internalImages
            : externalImages;
          if (!target.has(meta.ogImage)) target.set(meta.ogImage, page.url);
        }
      }
    }

    const checkImage = async (
      imageUrl: string,
      pageUrl: string,
      brokenSeverity: Finding["severity"],
    ): Promise<void> => {
      const result = await probe(imageUrl);
      if (result.kind === "unreachable" || result.status >= 400) {
        record({
          severity: brokenSeverity,
          url: pageUrl,
          message: `og:image does not resolve: ${imageUrl}${result.kind === "status" ? ` (HTTP ${String(result.status)})` : ""}`,
          recommendation:
            "Fix the image URL — a broken og:image makes every share of this page look broken.",
        });
        return;
      }
      if (result.contentType !== "" && !result.contentType.startsWith("image/")) {
        record({
          severity: "warning",
          url: pageUrl,
          message: `og:image is not an image (content-type ${result.contentType}): ${imageUrl}`,
          recommendation: "Point og:image at an actual image file (1200×630 recommended).",
        });
      }
    };

    await Promise.all(
      [...internalImages.entries()].map(([imageUrl, pageUrl]) =>
        checkImage(imageUrl, pageUrl, "error"),
      ),
    );
    if (ctx.environment === "production") {
      await Promise.all(
        [...externalImages.entries()].map(([imageUrl, pageUrl]) =>
          checkImage(imageUrl, pageUrl, "warning"),
        ),
      );
    }

    ctx.logger.debug("Social meta summary", {
      pagesChecked: pages.length,
      imagesProbed: probeCache.size,
      findings: findings.length,
    });

    const cleanPages = pages.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / pages.length), findings };
  },
};
```

Register in `src/engine/registry.ts` after `structuredDataCheck`.

Tests (`tests/check-social-meta.test.ts`) — contextFor pattern with fetch stub (route map like check-links tests). Numbered spec:

1. Registered as a built-in.
2. Page with complete OG set + twitter:card + same-origin og:image stubbed 200/image/png → `{ score: 100, findings: [] }`.
3. Page with zero og tags → exactly ONE warning ("no Open Graph tags"), score 100.
4. Page with og:title only → warnings for og:description/og:image/og:url (3), info for twitter:card, score 100.
5. Relative og:image (`/img/share.png`) → warning "not an absolute URL", no probe (fetch stub log empty).
6. Same-origin og:image stubbed 404 → error, score reflects dirty page.
7. Same og:image on two pages, broken → probed once (assert via the stub log) and ONE error attributed to the first referencing page. This first-page attribution is a deliberate v1 choice (og:images are usually page-specific, unlike shared assets); the test pins it. Note for the whole-branch reviewer: links.ts uses Set-of-referencing-pages attribution for shared assets — if shared og:images turn out to matter, mirroring that is the upgrade path.
8. Cross-origin og:image broken: in ci → NOT probed (stub log shows no request); in production → probed, warning severity, score 100.
9. Non-image content-type (text/html) on a 200 og:image → warning.
10. Empty store → `{ score: 100, findings: [] }`.

**Expected integration blowback:** existing integration fixtures have no og: tags → this check adds one warning per page (never errors) → statuses shift pass→warn but grades/exit codes unchanged. Root-cause anything beyond that.

TDD: tests first, implement, PASS, `npm run format && npm run verify`, commit:

```bash
git add src/checks/seo/social-meta.ts src/engine/registry.ts tests/check-social-meta.test.ts
git commit -m "feat: add seo.social-meta check validating Open Graph tags and og:image"
```

---

### Task 3: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Integration test** — append to `tests/run-review.test.ts`:

```ts
it("surfaces broken og:image from crawled pages", async () => {
  server = await startServer((req, res) => {
    if (req.url === "/share.png") {
      res.statusCode = 404;
      res.end("gone");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<html lang="en"><head><title>t</title><meta property="og:title" content="T"><meta property="og:image" content="${server?.url ?? ""}/share.png"></head><body>ok</body></html>`,
    );
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const seo = report.categories.find((category) => category.id === "seo");
  const check = seo?.checks.find((entry) => entry.id === "seo.social-meta");
  expect(check?.status).toBe("fail");
  expect(
    check?.findings.some(
      (finding) => finding.severity === "error" && finding.message.includes("/share.png"),
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: README row** (after `seo.structured-data`):

```markdown
| `seo.social-meta` | Open Graph/Twitter tags present per page; og:image is absolute, resolves, and is an image (external images probed in production only) |
```

- [ ] **Step 3: Verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: local fixture with a broken og:image via `node dist/cli.js <url> --env ci --format console`.

```bash
git add -A
git commit -m "feat: document social-meta check and add integration coverage"
git push -u origin feat/social-meta
gh pr create --base main --title "feat: seo.social-meta check (PR 9)" --body "PR 9 of the roadmap — the last fetch-tier check: Open Graph / Twitter Card presence per page, og:image validation (absolute URL, resolves via HEAD-with-GET-fallback, image content-type; same-origin broken images are blocking errors, cross-origin probed in production only). Performance ride-along: one shared parsed DOM per page across all checks (was 4 cheerio parses/page). Pixel-dimension validation deferred (would need an image-parsing dependency). No report schema change; no new dependencies.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

The fetch tier is complete. PR 10 per the spec roadmap is `content.placeholders` + `content.images`; PRs 12–15 begin the browser tier (Lighthouse, axe, console errors, analytics) with optional peer dependencies.
