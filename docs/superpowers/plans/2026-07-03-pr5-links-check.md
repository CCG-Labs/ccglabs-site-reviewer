# Site Reviewer PR 5 (functionality.links) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `functionality.links` check — broken internal links and assets (errors, merge-blocking), missing anchor targets (warnings), and external link validation (production-only, warnings, capped).

**Architecture:** A fragment-preserving reference extractor (`extractPageRefs`) walks each crawled HTML page for anchor links and asset references (img/src+srcset, source, script, stylesheet, video/audio). Internal link targets are resolved against the PageStore (no re-fetching); internal assets and external URLs are probed via `ctx.fetch` (HEAD with GET fallback on 405/501) through a per-run cache. Scoring mirrors `seo.meta-tags`: share of pages with no error-severity finding. When the crawl was capped, links to un-stored pages are skipped as unverifiable (debug-logged), never guessed.

**Tech Stack:** cheerio, existing PageStore/fixturePageStore, `allowedOriginsFor` exported from the crawler (ride-along refactor).

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`. Report schema UNCHANGED (no `REPORT_VERSION` bump).
- No `eval` / `new Function` / `child_process` in `src/`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- Check id `functionality.links`, category `functionality`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`; external URLs are collected and probed ONLY when `ctx.environment === "production"`, and external findings are ALWAYS warnings (never errors) so they can never trip the blocking gate.
- Severities: internal link target 4xx/5xx or unfetchable → **error** (attributed to the page containing the link); missing anchor target → **warning**; internal asset 4xx/5xx/unreachable → **error**; external link/asset 404/410/5xx/unreachable → **warning**; external 403/429 → debug log only (bot protection, not evidence of breakage).
- Fragments `""` (bare `#`) and `top` are always valid (browser built-ins). Fragment checks are skipped for targets whose stored body is empty (non-HTML).
- External probe cap: 50 unique URLs per run (constant `EXTERNAL_PROBE_LIMIT`); overflow is debug-logged.
- Check option `ignore: string[]` — substring match against the resolved URL; matching links/assets are skipped entirely (both internal and external).
- All probing through `ctx.fetch` (rate-limited, capped, redirect-policed). One probe per unique URL per run (cached).
- Scoring: pages = `htmlPages()` with 2xx status; `score = round(100 × pages-without-error-finding / pages)`; zero pages → `{ score: 100, findings: [] }`. Warnings never reduce score.
- Conventional commits. Branch: `feat/links-check` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/checks/functionality/link-extract.ts  extractPageRefs + hasAnchorTarget (pure parsers)
src/checks/functionality/links.ts         linksCheck
src/crawl/crawler.ts                      (ride-along) export allowedOriginsFor
src/engine/registry.ts                    register linksCheck
README.md                                 checks table row + ignore option docs
```

---

### Task 1: Reference extractor, anchor matcher, allowedOriginsFor export

**Files:**

- Create: `src/checks/functionality/link-extract.ts`
- Modify: `src/crawl/crawler.ts` (add `export` to `allowedOriginsFor` — no other change)
- Test: `tests/link-extract.test.ts`

**Interfaces:**

- Produces (Task 2 consumes):
  - `interface PageLink { url: string; fragment: string | undefined }`
  - `interface PageRefs { links: PageLink[]; assets: string[] }`
  - `extractPageRefs(html: string, pageUrl: string): PageRefs`
  - `hasAnchorTarget(html: string, fragment: string): boolean`
  - `allowedOriginsFor(base: URL): Set<string>` (now exported from `src/crawl/crawler.ts`)

- [ ] **Step 1: Write the failing test** — `tests/link-extract.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractPageRefs, hasAnchorTarget } from "../src/checks/functionality/link-extract.js";
import { allowedOriginsFor } from "../src/crawl/crawler.js";

describe("extractPageRefs", () => {
  it("extracts links with fragments preserved and resolved against the page", () => {
    const { links } = extractPageRefs(
      `<a href="/about#team">t</a><a href="/about">a</a><a href="https://ext.example/x">e</a>
       <a href="mailto:a@b.c">m</a><a href="#local">l</a>`,
      "https://example.com/dir/page",
    );
    expect(links).toEqual([
      { url: "https://example.com/about", fragment: "team" },
      { url: "https://example.com/about", fragment: undefined },
      { url: "https://ext.example/x", fragment: undefined },
      { url: "https://example.com/dir/page", fragment: "local" },
    ]);
  });

  it("dedupes identical url+fragment pairs and decodes encoded fragments", () => {
    const { links } = extractPageRefs(
      `<a href="/a#s%C3%A9ction">1</a><a href="/a#s%C3%A9ction">2</a>`,
      "https://example.com/",
    );
    expect(links).toEqual([{ url: "https://example.com/a", fragment: "séction" }]);
  });

  it("collects assets from img src/srcset, source, script, stylesheet, video and audio", () => {
    const { assets } = extractPageRefs(
      `<img src="/i.png">
       <img srcset="/i-1x.png 1x, /i-2x.png 2x">
       <source srcset="/s.webp 100w" src="/s.mp4">
       <script src="/app.js"></script>
       <link rel="stylesheet" href="/main.css">
       <link rel="icon" href="/favicon.ico">
       <video src="/v.mp4"></video><audio src="/a.mp3"></audio>
       <img src="data:image/png;base64,AAAA">`,
      "https://example.com/",
    );
    expect(assets.sort()).toEqual([
      "https://example.com/a.mp3",
      "https://example.com/app.js",
      "https://example.com/i-1x.png",
      "https://example.com/i-2x.png",
      "https://example.com/i.png",
      "https://example.com/main.css",
      "https://example.com/s.mp4",
      "https://example.com/s.webp",
      "https://example.com/v.mp4",
    ]);
  });
});

describe("hasAnchorTarget", () => {
  const html = `<div id="team"></div><a name="legacy"></a><section id="a&quot;b"></section>`;
  it("finds element ids and legacy a[name] anchors", () => {
    expect(hasAnchorTarget(html, "team")).toBe(true);
    expect(hasAnchorTarget(html, "legacy")).toBe(true);
    expect(hasAnchorTarget(html, "missing")).toBe(false);
  });
  it("always accepts empty and top fragments", () => {
    expect(hasAnchorTarget(html, "")).toBe(true);
    expect(hasAnchorTarget(html, "top")).toBe(true);
  });
  it("matches ids containing quotes without selector injection", () => {
    expect(hasAnchorTarget(html, 'a"b')).toBe(true);
  });
});

describe("allowedOriginsFor (exported)", () => {
  it("returns the base origin plus its https twin for http bases", () => {
    expect(allowedOriginsFor(new URL("http://example.com/"))).toEqual(
      new Set(["http://example.com", "https://example.com"]),
    );
    expect(allowedOriginsFor(new URL("https://example.com/"))).toEqual(
      new Set(["https://example.com"]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/link-extract.test.ts` — Expected: FAIL (module not found; `allowedOriginsFor` not exported).

- [ ] **Step 3: Export `allowedOriginsFor`** — in `src/crawl/crawler.ts`, change `function allowedOriginsFor(` to `export function allowedOriginsFor(`. Nothing else.

- [ ] **Step 4: Write `src/checks/functionality/link-extract.ts`**

```ts
import { load } from "cheerio";
import { normalizePageUrl } from "../../crawl/url.js";

export interface PageLink {
  /** fragment-stripped absolute URL */
  url: string;
  /** decoded fragment, when the link had one */
  fragment: string | undefined;
}

export interface PageRefs {
  links: PageLink[];
  assets: string[];
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function parseSrcset(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url !== "");
}

/** Extract every anchor link (fragment preserved) and asset reference from one HTML page. */
export function extractPageRefs(html: string, pageUrl: string): PageRefs {
  const $ = load(html);

  const links = new Map<string, PageLink>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    const fragment = resolved.hash === "" ? undefined : decodeFragment(resolved.hash.slice(1));
    resolved.hash = "";
    const key = `${resolved.href}#${fragment ?? "�"}`;
    if (!links.has(key)) links.set(key, { url: resolved.href, fragment });
  });

  const assets = new Set<string>();
  const addAsset = (raw: string | undefined): void => {
    if (raw === undefined || raw.trim() === "") return;
    const normalized = normalizePageUrl(raw, pageUrl);
    if (normalized !== undefined) assets.add(normalized);
  };
  $("img[src], source[src], video[src], audio[src], script[src]").each((_index, element) => {
    addAsset($(element).attr("src"));
  });
  $("img[srcset], source[srcset]").each((_index, element) => {
    for (const candidate of parseSrcset($(element).attr("srcset") ?? "")) addAsset(candidate);
  });
  $('link[rel~="stylesheet" i][href]').each((_index, element) => {
    addAsset($(element).attr("href"));
  });

  return { links: [...links.values()], assets: [...assets] };
}

/** True when the fragment resolves to an element on the page (id or legacy a[name]). */
export function hasAnchorTarget(html: string, fragment: string): boolean {
  if (fragment === "" || fragment === "top") return true;
  const $ = load(html);
  const idMatch = $("[id]")
    .toArray()
    .some((element) => $(element).attr("id") === fragment);
  if (idMatch) return true;
  return $("a[name]")
    .toArray()
    .some((element) => $(element).attr("name") === fragment);
}
```

- [ ] **Step 5: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/link-extract.test.ts` — Expected: PASS. (The first test's expected `links` array order follows document order of first occurrence — cheerio's `.each` is document-ordered, and the Map preserves insertion order.)
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/checks/functionality/link-extract.ts src/crawl/crawler.ts tests/link-extract.test.ts
git commit -m "feat: add fragment-preserving link/asset extractor and export allowedOriginsFor"
```

---

### Task 2: linksCheck — internal links, anchors, assets

**Files:**

- Create: `src/checks/functionality/links.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-links.test.ts`

**Interfaces:**

- Consumes: Task 1's exports; `ctx.pages` (store lookups by URL are normalized internally); `fixturePageStore`.
- Produces: `linksCheck: Check` (id `functionality.links`) registered in `builtinChecks`. The external-probe branch is implemented here too but only activates in production (Task 3 adds its tests/docs).

- [ ] **Step 1: Write the failing test** — `tests/check-links.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { linksCheck } from "../src/checks/functionality/links.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const html = (body: string) =>
  `<html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

type FetchStub = (url: string, init?: { method?: string }) => Promise<FetchResult>;

const stubResult = (url: string, status: number): FetchResult => ({
  url,
  status,
  ok: status >= 200 && status < 300,
  headers: {},
  body: "",
  redirected: false,
  durationMs: 1,
});

const fetchStub =
  (routes: Record<string, number | "reject">, log: string[] = []): FetchStub =>
  (url, init) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[url];
    if (route === undefined) return Promise.resolve(stubResult(url, 404));
    if (route === "reject") return Promise.reject(new Error("connection refused"));
    return Promise.resolve(stubResult(url, route));
  };

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  fetch: FetchStub = fetchStub({}),
  environment: Environment = "ci",
  checks: ResolvedConfig["checks"] = {},
  stats: Parameters<typeof fixturePageStore>[1] = {},
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
  pages: fixturePageStore(pages, stats),
  fetch,
  logger: { debug: () => undefined },
});

describe("functionality.links", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("functionality.links");
  });

  it("passes a site whose internal links and anchors all resolve", async () => {
    const outcome = await linksCheck.run(
      contextFor([
        { url: "https://example.com/", body: html('<a href="/about#team">a</a>') },
        {
          url: "https://example.com/about",
          body: html('<div id="team"></div><a href="/">home</a>'),
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags links to 404 pages and to unfetchable pages as errors on the linking page", async () => {
    const outcome = await linksCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: html('<a href="/gone">g</a><a href="/never-crawled">n</a>'),
        },
        { url: "https://example.com/gone", status: 404, ok: false, body: html("nope") },
      ]),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(2);
    expect(errors.every((finding) => finding.url === "https://example.com/")).toBe(true);
    expect(errors.map((finding) => finding.message).join(" ")).toContain("404");
    expect(outcome.score).toBe(0); // /gone is non-2xx so pages checked = [/] only; that one page carries errors
  });

  it("skips unverifiable links instead of guessing when the crawl was capped", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="/uncrawled">u</a>') }],
        fetchStub({}),
        "ci",
        {},
        { capped: true },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns on missing anchor targets without failing the run", async () => {
    const outcome = await linksCheck.run(
      contextFor([
        { url: "https://example.com/", body: html('<a href="/about#nope">a</a>') },
        { url: "https://example.com/about", body: html('<div id="team"></div>') },
      ]),
    );
    expect(outcome.score).toBe(100);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("#nope");
  });

  it("probes internal assets with HEAD, falls back to GET on 405, and errors on broken ones", async () => {
    const log: string[] = [];
    const outcome = await linksCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/",
            body: html(
              '<img src="/ok.png"><img src="/missing.png"><script src="/fussy.js"></script>',
            ),
          },
        ],
        fetchStub(
          {
            "https://example.com/ok.png": 200,
            "https://example.com/missing.png": 404,
            "https://example.com/fussy.js": 405,
          },
          log,
        ),
      ),
    );
    // 405 → GET fallback; the stub returns 405 again, which counts as broken (>=400)
    expect(log).toContain("HEAD https://example.com/ok.png");
    expect(log).toContain("GET https://example.com/fussy.js");
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => finding.message).join(" ")).toContain("/missing.png");
    expect(outcome.score).toBe(0);
  });

  it("probes each unique URL once across pages", async () => {
    const log: string[] = [];
    await linksCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: html('<img src="/shared.png">') },
          { url: "https://example.com/two", body: html('<img src="/shared.png">') },
        ],
        fetchStub({ "https://example.com/shared.png": 200 }, log),
      ),
    );
    expect(log.filter((entry) => entry.includes("/shared.png"))).toHaveLength(1);
  });

  it("honors the ignore option for links and assets", async () => {
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="/gone">g</a><img src="/dead.png">') }],
        fetchStub({}),
        "ci",
        { "functionality.links": { options: { ignore: ["/gone", "/dead.png"] } } },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("does not probe external URLs outside production", async () => {
    const log: string[] = [];
    const outcome = await linksCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: html('<a href="https://ext.example/dead">e</a>') }],
        fetchStub({}, log),
        "ci",
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(log).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check-links.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/functionality/links.ts`**

```ts
import { allowedOriginsFor } from "../../crawl/crawler.js";
import type { Check, CheckContext, Finding } from "../../types.js";
import { extractPageRefs, hasAnchorTarget } from "./link-extract.js";

const EXTERNAL_PROBE_LIMIT = 50;

interface LinkCheckOptions {
  ignore: string[];
}

function linkOptions(ctx: CheckContext): LinkCheckOptions {
  const raw = ctx.config.checks["functionality.links"]?.options?.["ignore"];
  return {
    ignore: Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

type ProbeResult = { kind: "status"; status: number } | { kind: "unreachable"; message: string };

export const linksCheck: Check = {
  id: "functionality.links",
  category: "functionality",
  description:
    "Internal links, anchors, and assets resolve; external links are validated in production (non-blocking).",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    ctx.logger.debug("Checking links", { pagesChecked: pages.length });
    if (pages.length === 0) return { score: 100, findings: [] };

    const options = linkOptions(ctx);
    const isIgnored = (url: string): boolean =>
      options.ignore.some((pattern) => url.includes(pattern));
    const allowedOrigins = allowedOriginsFor(new URL(ctx.baseUrl));
    const capped = ctx.pages.stats().capped;

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    const probeCache = new Map<string, Promise<ProbeResult>>();
    const probe = (url: string): Promise<ProbeResult> => {
      const cached = probeCache.get(url);
      if (cached !== undefined) return cached;
      const result = (async (): Promise<ProbeResult> => {
        try {
          const head = await ctx.fetch(url, { method: "HEAD" });
          if (head.status === 405 || head.status === 501) {
            const get = await ctx.fetch(url);
            return { kind: "status", status: get.status };
          }
          return { kind: "status", status: head.status };
        } catch (error) {
          return {
            kind: "unreachable",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })();
      probeCache.set(url, result);
      return result;
    };

    /** external URL (or internal asset) → first page that referenced it */
    const internalAssetRefs = new Map<string, string>();
    const externalRefs = new Map<string, string>();
    let unverifiable = 0;

    for (const page of pages) {
      const refs = extractPageRefs(page.body, page.finalUrl);

      for (const link of refs.links) {
        if (isIgnored(link.url)) continue;
        if (allowedOrigins.has(new URL(link.url).origin)) {
          const target = ctx.pages.get(link.url);
          if (target === undefined) {
            if (capped) {
              unverifiable += 1;
              continue;
            }
            record({
              severity: "error",
              url: page.url,
              message: `Broken internal link: ${link.url} could not be fetched.`,
              recommendation: "Fix or remove the link; the target did not respond when crawled.",
            });
          } else if (target.status >= 400) {
            record({
              severity: "error",
              url: page.url,
              message: `Broken internal link: ${link.url} returns HTTP ${String(target.status)}.`,
              recommendation: "Fix or remove the link, or restore the target page.",
            });
          } else if (
            link.fragment !== undefined &&
            target.body !== "" &&
            !hasAnchorTarget(target.body, link.fragment)
          ) {
            record({
              severity: "warning",
              url: page.url,
              message: `Anchor #${link.fragment} not found on ${link.url}.`,
              recommendation: "Point the fragment at an existing element id, or remove it.",
            });
          }
        } else if (ctx.environment === "production" && !externalRefs.has(link.url)) {
          externalRefs.set(link.url, page.url);
        }
      }

      for (const asset of refs.assets) {
        if (isIgnored(asset)) continue;
        if (allowedOrigins.has(new URL(asset).origin)) {
          if (!internalAssetRefs.has(asset)) internalAssetRefs.set(asset, page.url);
        } else if (ctx.environment === "production" && !externalRefs.has(asset)) {
          externalRefs.set(asset, page.url);
        }
      }
    }

    await Promise.all(
      [...internalAssetRefs.entries()].map(async ([assetUrl, pageUrl]) => {
        const result = await probe(assetUrl);
        if (result.kind === "unreachable") {
          record({
            severity: "error",
            url: pageUrl,
            message: `Asset unreachable: ${assetUrl} (${result.message}).`,
            recommendation: "Fix the asset path or restore the file.",
          });
        } else if (result.status >= 400) {
          record({
            severity: "error",
            url: pageUrl,
            message: `Broken asset: ${assetUrl} returns HTTP ${String(result.status)}.`,
            recommendation: "Fix the asset path or restore the file.",
          });
        }
      }),
    );

    const externalEntries = [...externalRefs.entries()];
    if (externalEntries.length > EXTERNAL_PROBE_LIMIT) {
      ctx.logger.debug("External probe cap reached", {
        probed: EXTERNAL_PROBE_LIMIT,
        skipped: externalEntries.length - EXTERNAL_PROBE_LIMIT,
      });
      externalEntries.length = EXTERNAL_PROBE_LIMIT;
    }
    await Promise.all(
      externalEntries.map(async ([url, pageUrl]) => {
        const result = await probe(url);
        if (result.kind === "unreachable") {
          record({
            severity: "warning",
            url: pageUrl,
            message: `External link unreachable: ${url} (${result.message}).`,
            recommendation: "Verify the destination still exists; update or remove the link.",
          });
        } else if (result.status === 403 || result.status === 429) {
          ctx.logger.debug("External target refused the automated request", {
            url,
            status: result.status,
          });
        } else if (result.status >= 400) {
          record({
            severity: "warning",
            url: pageUrl,
            message: `Broken external link: ${url} returns HTTP ${String(result.status)}.`,
            recommendation: "Update or remove the link.",
          });
        }
      }),
    );

    if (unverifiable > 0) {
      ctx.logger.debug("Internal links skipped as unverifiable (crawl capped)", {
        count: unverifiable,
      });
    }

    const cleanPages = pages.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / pages.length), findings };
  },
};
```

- [ ] **Step 4: Register it** — in `src/engine/registry.ts`, import `linksCheck` from `../checks/functionality/links.js` and append it to `builtinChecks` (after `crawlCoverageCheck`, before `metaTagsCheck`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/check-links.test.ts` — Expected: PASS (9 tests). Then `npx vitest run` — existing integration tests must still pass: the run-review fixture servers that DO set text/html (the meta-tags integration test) now also run linksCheck; its pages' internal links (`/bare`) resolve in the store with 200, so no new failures. Investigate root-cause if anything fails.

- [ ] **Step 6: Full verify and commit**

Run: `npm run format && npm run verify` — Expected: green.

```bash
git add src/checks/functionality/links.ts src/engine/registry.ts tests/check-links.test.ts
git commit -m "feat: add functionality.links check for internal links, anchors, and assets"
```

---

### Task 3: External-link tests, README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/check-links.test.ts` (external branch), `tests/run-review.test.ts` (one integration case)

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Add external-branch tests** — append to `tests/check-links.test.ts`:

```ts
it("warns on broken external links in production, attributed to the referencing page", async () => {
  const outcome = await linksCheck.run(
    contextFor(
      [
        {
          url: "https://example.com/",
          body: html(
            '<a href="https://ext.example/dead">e</a><a href="https://ext.example/alive">a</a>',
          ),
        },
      ],
      fetchStub({ "https://ext.example/dead": 404, "https://ext.example/alive": 200 }),
      "production",
    ),
  );
  expect(outcome.score).toBe(100); // warnings never reduce score
  expect(outcome.findings).toHaveLength(1);
  expect(outcome.findings[0]?.severity).toBe("warning");
  expect(outcome.findings[0]?.message).toContain("https://ext.example/dead");
  expect(outcome.findings[0]?.url).toBe("https://example.com/");
});

it("treats external 403/429 as bot protection, not breakage", async () => {
  const outcome = await linksCheck.run(
    contextFor(
      [{ url: "https://example.com/", body: html('<a href="https://ext.example/waf">w</a>') }],
      fetchStub({ "https://ext.example/waf": 403 }),
      "production",
    ),
  );
  expect(outcome).toEqual({ score: 100, findings: [] });
});

it("caps external probing at 50 unique URLs", async () => {
  const log: string[] = [];
  const body = html(
    Array.from({ length: 60 }, (_v, i) => `<a href="https://ext.example/p${String(i)}">x</a>`).join(
      "",
    ),
  );
  const routes: Record<string, number> = {};
  for (let i = 0; i < 60; i += 1) routes[`https://ext.example/p${String(i)}`] = 200;
  await linksCheck.run(
    contextFor([{ url: "https://example.com/", body }], fetchStub(routes, log), "production"),
  );
  expect(log).toHaveLength(50);
});
```

Run: `npx vitest run tests/check-links.test.ts` — Expected: PASS (12 tests).

- [ ] **Step 2: Integration test** — append to `tests/run-review.test.ts`:

```ts
it("surfaces broken internal links from crawled pages", async () => {
  server = await startServer((req, res) => {
    if (req.url === "/missing.css" || req.url === "/gone") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<html lang="en"><head><title>Home</title><meta name="description" content="A perfectly reasonable description that sits comfortably within the limits."><link rel="canonical" href="/"><link rel="stylesheet" href="/missing.css"></head><body><h1>Hi</h1><a href="/gone">gone</a></body></html>',
    );
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const functionality = report.categories.find((category) => category.id === "functionality");
  const check = functionality?.checks.find((entry) => entry.id === "functionality.links");
  expect(check?.status).toBe("fail");
  const messages = (check?.findings ?? []).map((finding) => finding.message).join(" ");
  expect(messages).toContain("/gone");
  expect(messages).toContain("/missing.css");
});
```

Run: `npx vitest run tests/run-review.test.ts` — Expected: PASS.

- [ ] **Step 3: README** — in the Checks table add a row after `functionality.crawl-coverage`:

```markdown
| `functionality.links` | internal links, anchors, and assets resolve (blocking); external links validated in production only (warnings, capped at 50) |
```

And extend the per-check options example:

```ts
export default defineConfig({
  checks: {
    "seo.meta-tags": {
      options: { noindexAllow: ["https://example.com/internal-tool"] },
    },
    "functionality.links": {
      options: { ignore: ["analytics.example", "/known-flaky-asset.png"] },
    },
  },
});
```

- [ ] **Step 4: Full verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: `npm run build`, serve a small local fixture site with a broken link, run `node dist/cli.js <url> --env ci --format console` — Expected: `functionality.links` findings appear.

```bash
git add -A
git commit -m "feat: validate external links in production and document the links check"
git push -u origin feat/links-check
gh pr create --base main --title "feat: functionality.links check (PR 5)" --body "PR 5 of the roadmap: broken internal links and assets (blocking errors), missing anchor targets (warnings), external link validation (production-only warnings, 50-URL cap, 403/429 treated as bot protection), per-check ignore option. Reuses the crawl — no page is fetched twice; assets probed HEAD-first with GET fallback. No report schema change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## After this plan

PR 6 (`seo.sitemap-robots`) validates sitemap contents against the store and robots.txt sanity. The PR 4 deferred backlog (http/https twin dedupe, multi-description flagging, noindexAllow normalization) remains in the ledger for a cleanup ride-along.
