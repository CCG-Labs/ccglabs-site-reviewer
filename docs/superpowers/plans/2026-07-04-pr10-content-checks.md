# Site Reviewer PR 10 (content.placeholders + content.images) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the content category: `content.placeholders` (lorem ipsum / unrendered template markers / `undefined`/`NaN` in visible text) and `content.images` (`<img>` alt/dimension hygiene + oversized-file detection).

**Architecture:** Both checks iterate 2xx `htmlPages()` via the shared `pageDom` cache. Placeholders: visible text is extracted from a **clone** of the cached DOM (script/style/noscript/template removed from the clone only — the shared handle must NEVER be mutated) and matched against a tuned blocklist; matches are errors (the classic launch embarrassment) except TODO/FIXME which warn. Images: `<img>` elements are inspected in place (read-only) — missing `alt` attribute is an error (WCAG baseline), missing both `width`+`height` warns (CLS), and same-origin image files are HEAD-probed for `content-length` over a threshold (cross-origin probed in production only, links-check precedent). Page-clean-ratio scoring for both.

**Tech Stack:** cheerio (existing), pageDom, PageStore. No new dependencies.

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`. Report schema UNCHANGED.
- No `eval` / `new Function` / `child_process`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- **DOM-cache safety (hard rule):** `pageDom(page)` handles are shared across checks and MUST NOT be mutated. The placeholder text extraction operates on `$("body").clone()` (or `$.root().clone()` when body is absent) and removes `script, style, noscript, template` from the CLONE only. A dedicated test proves the cached DOM is intact after the check runs (e.g. `extractPageMeta(pageDom(page))` still sees the title AND `pageDom(page)("script").length` is unchanged).
- `content.placeholders`: id `content.placeholders`, category `content`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`.
  - Visible text = clone-with-removals `.text()`, whitespace-normalized (`replace(/\s+/g, " ")`).
  - Default blocklist and severities (findings carry the page URL; each matched marker → ONE finding per page per marker, message shows a ±40-char excerpt around the first match):
    - `lorem ipsum` (case-insensitive) → **error**
    - `{{` or `}}` (literal, unrendered template syntax) → **error**
    - standalone word `undefined` (case-sensitive, `\bundefined\b`) → **error**
    - standalone word `NaN` (case-sensitive, `\bNaN\b`) → **error**
    - standalone words `TODO` / `FIXME` (case-sensitive, word-boundary) → **warning**
  - Check options: `patterns: string[]` (extra case-insensitive literal markers, treated as errors), `ignore: string[]` (page-URL substrings to skip entirely).
  - Scoring: page-clean-ratio (`round(100 × pages-without-error-finding / pages)`); zero pages → `{ score: 100, findings: [] }`.
- `content.images`: id `content.images`, category `content`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`.
  - Per `<img>` element on each page (read-only inspection of the shared DOM):
    - No `alt` ATTRIBUTE at all → **error** (empty `alt=""` is valid — decorative images). ONE finding per page listing up to 3 offending `src` values + count.
    - Both `width` and `height` attributes missing → **warning** (CLS risk). ONE aggregated finding per page (up to 3 srcs + count).
  - Oversized detection: unique image URLs (from `src`, resolved against `page.finalUrl` via `normalizePageUrl`) HEAD-probed once each (GET fallback on 405/501 — reuse the local probe-cache pattern); `content-length` header parsed; > `maxImageBytes` (default 500_000, override via check options) → **warning** per unique image (attributed to its first referencing page). Missing/unparseable content-length → skipped silently (debug count). Same-origin probed in all envs; cross-origin probed ONLY in production. Probe caps: 500 same-origin / 50 cross-origin (links-check precedent), overflow debug-logged.
  - `loading="lazy"` validation is explicitly OUT OF SCOPE (fold detection needs a browser — deferred to the browser tier).
  - Check options: `maxImageBytes: number`, `ignore: string[]` (URL substrings, applies to both findings and probes).
  - Scoring: page-clean-ratio; zero pages → `{ score: 100, findings: [] }`.
- Known duplication, accepted for now: `functionality.links` also HEAD-probes image assets (for brokenness) with its own cache — the same URL may be probed twice per run by the two checks. The shared run-level probe-cache helper is already ledgered; do NOT build it in this PR.
- Conventional commits. Branch: `feat/content-checks` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/checks/content/placeholders.ts  extractVisibleText + placeholdersCheck
src/checks/content/images.ts        imagesCheck
src/engine/registry.ts              register both (after socialMetaCheck)
README.md                           checks table rows
```

---

### Task 1: content.placeholders

**Files:**

- Create: `src/checks/content/placeholders.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-placeholders.test.ts`

**Interfaces:**

- Consumes: `pageDom`, `ctx.pages.htmlPages()`, `fixturePageStore`.
- Produces: `extractVisibleText($: CheerioAPI): string` (exported for tests) and `placeholdersCheck: Check` registered after `socialMetaCheck`.

Write `src/checks/content/placeholders.ts`:

```ts
import type { CheerioAPI } from "cheerio";
import { pageDom } from "../../crawl/page-dom.js";
import type { Check, CheckContext, Finding } from "../../types.js";

interface Marker {
  /** human-readable marker name for messages */
  label: string;
  severity: "error" | "warning";
  /** returns the index of the first match, or -1 */
  find(text: string): number;
}

const wordFinder = (word: string): ((text: string) => number) => {
  const pattern = new RegExp(`\\b${word}\\b`);
  return (text) => pattern.exec(text)?.index ?? -1;
};

const DEFAULT_MARKERS: Marker[] = [
  {
    label: "lorem ipsum",
    severity: "error",
    find: (text) => text.toLowerCase().indexOf("lorem ipsum"),
  },
  { label: "{{ (unrendered template)", severity: "error", find: (text) => text.indexOf("{{") },
  { label: "}} (unrendered template)", severity: "error", find: (text) => text.indexOf("}}") },
  { label: "undefined", severity: "error", find: wordFinder("undefined") },
  { label: "NaN", severity: "error", find: wordFinder("NaN") },
  { label: "TODO", severity: "warning", find: wordFinder("TODO") },
  { label: "FIXME", severity: "warning", find: wordFinder("FIXME") },
];

interface PlaceholderOptions {
  patterns: string[];
  ignore: string[];
}

function placeholderOptions(ctx: CheckContext): PlaceholderOptions {
  const raw = ctx.config.checks["content.placeholders"]?.options;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return { patterns: strings(raw?.["patterns"]), ignore: strings(raw?.["ignore"]) };
}

/**
 * Visible text of a page: everything a reader sees, excluding script/style/
 * noscript/template content. Operates on a CLONE — the shared pageDom handle
 * is never mutated.
 */
export function extractVisibleText($: CheerioAPI): string {
  const root = $("body").length > 0 ? $("body") : $.root();
  const clone = root.clone();
  clone.find("script, style, noscript, template").remove();
  return clone.text().replace(/\s+/g, " ").trim();
}

const excerpt = (text: string, index: number): string => {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

export const placeholdersCheck: Check = {
  id: "content.placeholders",
  category: "content",
  description:
    "No leftover placeholder text (lorem ipsum, template markers, undefined/NaN) in visible copy.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  run(ctx) {
    const options = placeholderOptions(ctx);
    const markers: Marker[] = [
      ...DEFAULT_MARKERS,
      ...options.patterns.map((pattern): Marker => ({
        label: pattern,
        severity: "error",
        find: (text) => text.toLowerCase().indexOf(pattern.toLowerCase()),
      })),
    ];

    const pages = ctx.pages
      .htmlPages()
      .filter((page) => page.status >= 200 && page.status < 300)
      .filter((page) => !options.ignore.some((pattern) => page.url.includes(pattern)));
    if (pages.length === 0) return Promise.resolve({ score: 100, findings: [] });

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();

    for (const page of pages) {
      const text = extractVisibleText(pageDom(page));
      for (const marker of markers) {
        const index = marker.find(text);
        if (index === -1) continue;
        findings.push({
          severity: marker.severity,
          url: page.url,
          message: `Placeholder "${marker.label}" found in visible text: "${excerpt(text, index)}"`,
          recommendation:
            "Replace the placeholder with real content before launch — this is visible to every visitor.",
        });
        if (marker.severity === "error") pagesWithErrors.add(page.url);
      }
    }

    ctx.logger.debug("Placeholder scan", { pagesChecked: pages.length, findings: findings.length });
    const cleanPages = pages.length - pagesWithErrors.size;
    return Promise.resolve({
      score: Math.round((100 * cleanPages) / pages.length),
      findings,
    });
  },
};
```

Register in `src/engine/registry.ts` after `socialMetaCheck`.

Tests (`tests/check-placeholders.test.ts`) — contextFor/fixturePageStore pattern. Numbered spec:

1. Registered as a built-in.
2. Clean page → `{ score: 100, findings: [] }`.
3. "Lorem Ipsum dolor…" in a paragraph → error with excerpt; score reflects dirty page.
4. `{{title}}` rendered literally → error mentioning "unrendered template".
5. Standalone `undefined` in text → error; but "undefinedBehavior" (no word boundary) and `Undefined` (case) → clean.
6. `TODO` in visible text → warning, score 100.
7. Markers inside `<script>`/`<style>` bodies (e.g. `var x = undefined;` in a script) → clean (visible-text extraction excludes them).
8. **DOM-cache non-mutation:** run the check on a page whose HTML has a `<script>` and a `<title>`; afterwards `pageDom(page)("script")` still finds the script and `extractPageMeta(pageDom(page)).titles` still sees the title.
9. Custom `patterns: ["INSERT CLIENT NAME"]` option → error on match (case-insensitive).
10. `ignore` option skips a matching page entirely.
11. Empty store → `{ score: 100, findings: [] }`.

**Expected integration blowback:** existing fixtures' visible text is tiny ("ok", "Hi") — no markers, no new findings expected. Root-cause anything that fails.

TDD: tests first, implement, PASS, `npm run format && npm run verify`, commit:

```bash
git add src/checks/content/placeholders.ts src/engine/registry.ts tests/check-placeholders.test.ts
git commit -m "feat: add content.placeholders check scanning visible text"
```

---

### Task 2: content.images

**Files:**

- Create: `src/checks/content/images.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-images.test.ts`

**Interfaces:**

- Consumes: `pageDom`, `normalizePageUrl`, `allowedOriginsFor`, `ctx.fetch`, `fixturePageStore`.
- Produces: `imagesCheck: Check` (id `content.images`) registered after `placeholdersCheck`.

Write `src/checks/content/images.ts`:

```ts
import { allowedOriginsFor } from "../../crawl/crawler.js";
import { pageDom } from "../../crawl/page-dom.js";
import { normalizePageUrl } from "../../crawl/url.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const DEFAULT_MAX_IMAGE_BYTES = 500_000;
const INTERNAL_PROBE_LIMIT = 500;
const EXTERNAL_PROBE_LIMIT = 50;
const SAMPLE = 3;

interface ImageOptions {
  maxImageBytes: number;
  ignore: string[];
}

function imageOptions(ctx: CheckContext): ImageOptions {
  const raw = ctx.config.checks["content.images"]?.options;
  const maxImageBytes =
    typeof raw?.["maxImageBytes"] === "number" && raw["maxImageBytes"] > 0
      ? raw["maxImageBytes"]
      : DEFAULT_MAX_IMAGE_BYTES;
  const ignore = Array.isArray(raw?.["ignore"])
    ? raw["ignore"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return { maxImageBytes, ignore };
}

const sampleList = (values: string[]): string =>
  `${values.slice(0, SAMPLE).join(", ")}${values.length > SAMPLE ? `, … (${String(values.length)} total)` : ""}`;

export const imagesCheck: Check = {
  id: "content.images",
  category: "content",
  description: "Images carry alt text and explicit dimensions, and image files are not oversized.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const options = imageOptions(ctx);
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
    /** unique image URL → first page referencing it */
    const internalImages = new Map<string, string>();
    const externalImages = new Map<string, string>();

    for (const page of pages) {
      const $ = pageDom(page);
      const missingAlt: string[] = [];
      const missingDimensions: string[] = [];
      $("img").each((_index, element) => {
        const img = $(element);
        const src = (img.attr("src") ?? "").trim();
        const display = src === "" ? "(inline image without src)" : src;
        if (options.ignore.some((pattern) => display.includes(pattern))) return;
        if (img.attr("alt") === undefined) missingAlt.push(display);
        if (img.attr("width") === undefined && img.attr("height") === undefined) {
          missingDimensions.push(display);
        }
        if (src !== "") {
          const resolved = normalizePageUrl(src, page.finalUrl);
          if (
            resolved !== undefined &&
            !options.ignore.some((pattern) => resolved.includes(pattern))
          ) {
            const target = allowedOrigins.has(new URL(resolved).origin)
              ? internalImages
              : externalImages;
            if (!target.has(resolved)) target.set(resolved, page.url);
          }
        }
      });
      if (missingAlt.length > 0) {
        record({
          severity: "error",
          url: page.url,
          message: `${String(missingAlt.length)} image(s) missing an alt attribute: ${sampleList(missingAlt)}`,
          recommendation:
            'Add alt text describing each image (or alt="" for purely decorative ones) — required for screen readers.',
        });
      }
      if (missingDimensions.length > 0) {
        record({
          severity: "warning",
          url: page.url,
          message: `${String(missingDimensions.length)} image(s) without width/height attributes: ${sampleList(missingDimensions)}`,
          recommendation:
            "Add explicit width and height so the browser reserves space and avoids layout shift.",
        });
      }
    }

    const probeCache = new Map<string, Promise<number | undefined>>();
    const contentLength = (url: string): Promise<number | undefined> => {
      const cached = probeCache.get(url);
      if (cached !== undefined) return cached;
      const result = (async (): Promise<number | undefined> => {
        try {
          let response = await ctx.fetch(url, { method: "HEAD" });
          if (response.status === 405 || response.status === 501) response = await ctx.fetch(url);
          const raw = response.headers["content-length"];
          const parsed = raw === undefined ? Number.NaN : Number(raw);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
        } catch {
          return undefined;
        }
      })();
      probeCache.set(url, result);
      return result;
    };

    const checkSize = async (imageUrl: string, pageUrl: string): Promise<void> => {
      const bytes = await contentLength(imageUrl);
      if (bytes !== undefined && bytes > options.maxImageBytes) {
        record({
          severity: "warning",
          url: pageUrl,
          message: `Oversized image (${String(Math.round(bytes / 1024))} KB, limit ${String(Math.round(options.maxImageBytes / 1024))} KB): ${imageUrl}`,
          recommendation:
            "Compress or resize the image (WebP/AVIF, responsive srcset) — heavy images are the top cause of slow LCP.",
        });
      }
    };

    const internalEntries = [...internalImages.entries()];
    if (internalEntries.length > INTERNAL_PROBE_LIMIT) {
      ctx.logger.debug("Internal image probe cap reached", {
        skipped: internalEntries.length - INTERNAL_PROBE_LIMIT,
      });
      internalEntries.length = INTERNAL_PROBE_LIMIT;
    }
    await Promise.all(internalEntries.map(([imageUrl, pageUrl]) => checkSize(imageUrl, pageUrl)));

    if (ctx.environment === "production") {
      const externalEntries = [...externalImages.entries()];
      if (externalEntries.length > EXTERNAL_PROBE_LIMIT) {
        ctx.logger.debug("External image probe cap reached", {
          skipped: externalEntries.length - EXTERNAL_PROBE_LIMIT,
        });
        externalEntries.length = EXTERNAL_PROBE_LIMIT;
      }
      await Promise.all(externalEntries.map(([imageUrl, pageUrl]) => checkSize(imageUrl, pageUrl)));
    }

    ctx.logger.debug("Image scan", {
      pagesChecked: pages.length,
      imagesProbed: probeCache.size,
      findings: findings.length,
    });
    const cleanPages = pages.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / pages.length), findings };
  },
};
```

Register in `src/engine/registry.ts` after `placeholdersCheck`.

Tests (`tests/check-images.test.ts`) — fetch-stub pattern; stub responses need a `content-length` header (extend the local stub to accept headers). Numbered spec:

1. Registered as a built-in.
2. Page with `<img src="/a.png" alt="A" width="10" height="10">`, stub content-length 1000 → `{ score: 100, findings: [] }`.
3. Image with NO alt attribute → error listing the src; `alt=""` → clean.
4. Image missing both width and height → aggregated warning; width-only present → clean (only both-missing warns).
5. Oversized same-origin image (content-length 600000, default limit) → warning naming KB; `maxImageBytes: 1000000` option → clean.
6. Missing content-length header → no size finding (skipped).
7. Same image on two pages → probed once (stub log).
8. Cross-origin image: not probed in ci; probed in production.
9. `ignore` option suppresses both the alt finding and the probe for matching srcs.
10. Empty store → `{ score: 100, findings: [] }`.

**Expected integration blowback:** existing fixtures have few/no `<img>` tags — the meta-tags/links/sitemap fixtures are text-only; no new findings expected. If a fixture does carry an img without alt, the content category appears with an error and could flip a pass-grade test — repair the FIXTURE (add alt/width/height), never the assertion.

TDD: tests first, implement, PASS, `npm run format && npm run verify`, commit:

```bash
git add src/checks/content/images.ts src/engine/registry.ts tests/check-images.test.ts
git commit -m "feat: add content.images check for alt text, dimensions, and oversized files"
```

---

### Task 3: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Integration test** — append to `tests/run-review.test.ts`:

```ts
it("surfaces placeholder text and image hygiene issues from crawled pages", async () => {
  server = await startServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<html lang="en"><head><title>t</title></head><body><p>Lorem ipsum dolor sit amet.</p><img src="/logo.png"></body></html>',
    );
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const content = report.categories.find((category) => category.id === "content");
  const placeholders = content?.checks.find((entry) => entry.id === "content.placeholders");
  const images = content?.checks.find((entry) => entry.id === "content.images");
  expect(placeholders?.status).toBe("fail");
  expect(placeholders?.findings.some((finding) => finding.message.includes("lorem ipsum"))).toBe(
    true,
  );
  expect(images?.status).toBe("fail");
  expect(images?.findings.some((finding) => finding.message.includes("alt"))).toBe(true);
});
```

- [ ] **Step 2: README rows** (after `seo.social-meta`):

```markdown
| `content.placeholders` | no lorem ipsum, unrendered `{{templates}}`, stray `undefined`/`NaN` (errors) or TODO/FIXME (warnings) in visible text |
| `content.images` | images carry alt text (error when missing) and width/height (warning); same-origin image files probed for oversize (warning, 500 KB default) |
```

- [ ] **Step 3: Verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: local fixture with lorem ipsum + alt-less img via `node dist/cli.js <url> --env ci --format console` (integration test covers the same path if the sandbox blocks the subprocess).

```bash
git add -A
git commit -m "feat: document content checks and add integration coverage"
git push -u origin feat/content-checks
gh pr create --base main --title "feat: content.placeholders + content.images checks (PR 10)" --body "PR 10 of the roadmap — opens the content category. Placeholders: visible-text scan (clone-based, shared DOM never mutated) for lorem ipsum, unrendered {{template}} markers, stray undefined/NaN (errors) and TODO/FIXME (warnings), with custom patterns + ignore options. Images: missing alt attribute is a blocking error (empty alt allowed for decorative), missing width+height warns (CLS), same-origin image files HEAD-probed for content-length over 500 KB (cross-origin in production only; capped 500/50). loading=lazy validation deferred to the browser tier (fold detection). No report schema change; no new dependencies.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

PR 11 (`functionality.error-pages` + `security.sensitive-files`) completes the fetch-adjacent set; PRs 12–15 are the browser tier. Ledger backlog: shared run-level probe cache is now referenced by THREE checks' local caches (links, social-meta, images) — strong candidate for PR 11's ride-along.
