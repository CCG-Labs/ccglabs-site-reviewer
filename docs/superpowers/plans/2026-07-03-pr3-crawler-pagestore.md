# Site Reviewer PR 3 (Crawler + PageStore) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a same-origin BFS crawler with sitemap seeding whose results (a shared `PageStore`) every check reads, surface crawl coverage in the report (`REPORT_VERSION` 2), and stop checks from re-fetching pages.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-03-site-reviewer-design.md`): the crawler seeds from the base URL plus `sitemap.xml`, BFS-crawls same-origin pages up to `maxPages` (default 200) through the existing capped/rate-limited fetcher, and stores per-page results in a `PageStore` exposed on `CheckContext.pages`. A new `functionality.crawl-coverage` check warns when the cap truncated coverage, and the report gains a `crawl` block.

**Tech Stack:** TypeScript strict/ESM, cheerio (HTML/XML parsing — pre-approved in the spec's stack list), existing `createFetcher`, vitest with real local HTTP servers.

## Global Constraints

- Runtime dependencies now exactly: `commander`, `zod`, `jiti`, `cheerio` (cheerio is named in the approved spec's stack; no other additions).
- No `eval`, `new Function`, or `child_process` in `src/` (ESLint-enforced).
- Coverage thresholds 90% on `src/**` (excluding `src/cli.ts`, `src/index.ts`) — never lowered.
- Report schema change ⇒ `REPORT_VERSION` bump to `2` (test-enforced pin).
- All network access in `src/crawl/` goes through the injected `RateLimitedFetch` — no direct `fetch()` calls (preserves caps, redirect policy, redaction).
- `requestHeaders` never appear in `PageStore` contents beyond what `FetchResult` already exposes (response headers only).
- Conventional commits. Branch: `feat/crawler`, PR base `main`.
- Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/crawl/url.ts            normalizePageUrl (fragment-strip, http(s)-only)
src/crawl/extract-links.ts  extractLinks(html, pageUrl) — all http(s) anchors, normalized
src/crawl/sitemap.ts        fetchSitemapUrls(fetch, origin) — urlset + 1-level sitemapindex
src/crawl/crawler.ts        SitePageStore + crawlSite(options)
src/checks/functionality/crawl-coverage.ts
src/types.ts                +CrawledPage, +CrawlStats, +PageStore, CheckContext.pages
src/report/schema.ts        +crawl block, REPORT_VERSION 2
src/engine/run-review.ts    crawl before checks; crawl stats in report
src/checks/functionality/reachable.ts  reads base page from PageStore
src/reporters/console.ts    crawl summary line
tests/helpers/page-store.ts fixturePageStore for check tests
```

---

### Task 1: URL normalization, PageStore contract types, fixture helper

**Files:**

- Create: `src/crawl/url.ts`, `tests/helpers/page-store.ts`
- Modify: `src/types.ts` (append new interfaces; do NOT touch `CheckContext` yet — that lands in Task 5)
- Test: `tests/crawl-url.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `normalizePageUrl(raw: string, base?: string): string | undefined` from `src/crawl/url.ts`
  - Types from `src/types.ts`: `CrawledPage { url; finalUrl; status; ok; headers: Record<string,string>; body; redirected; durationMs }`, `CrawlStats { pagesDiscovered; pagesScanned; capped }`, `PageStore { get(url): CrawledPage | undefined; all(): CrawledPage[]; htmlPages(): CrawledPage[]; stats(): CrawlStats }`
  - `fixturePageStore(pages?: Partial<CrawledPage> & { url: string }[], stats?: Partial<CrawlStats>): PageStore` from `tests/helpers/page-store.ts`

- [ ] **Step 1: Create branch**

```bash
git checkout main && git pull && git checkout -b feat/crawler
```

- [ ] **Step 2: Write the failing test** — `tests/crawl-url.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { normalizePageUrl } from "../src/crawl/url.js";

describe("normalizePageUrl", () => {
  it("resolves relative URLs against a base", () => {
    expect(normalizePageUrl("/about", "https://example.com/index.html")).toBe(
      "https://example.com/about",
    );
  });

  it("strips fragments but keeps query strings", () => {
    expect(normalizePageUrl("https://example.com/a?q=1#section")).toBe("https://example.com/a?q=1");
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizePageUrl("mailto:a@b.c")).toBeUndefined();
    expect(normalizePageUrl("javascript:void(0)", "https://example.com/")).toBeUndefined();
    expect(normalizePageUrl("tel:+15555555555", "https://example.com/")).toBeUndefined();
  });

  it("returns undefined for unparseable input", () => {
    expect(normalizePageUrl("http://")).toBeUndefined();
    expect(normalizePageUrl("not a url")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/crawl-url.test.ts`
Expected: FAIL — cannot resolve `../src/crawl/url.js`.

- [ ] **Step 4: Write `src/crawl/url.ts`**

```ts
/**
 * Normalize a discovered link into a crawlable page URL: resolve against the
 * page it appeared on, strip the fragment, and reject non-http(s) schemes.
 * Returns undefined for anything that is not a crawlable web URL.
 */
export function normalizePageUrl(raw: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  return url.href;
}
```

- [ ] **Step 5: Append the PageStore contract to `src/types.ts`** (after the `RateLimitedFetch` type; `CheckContext` stays unchanged in this task)

```ts
export interface CrawledPage {
  /** normalized URL as requested by the crawler */
  url: string;
  /** final URL after redirects */
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  redirected: boolean;
  durationMs: number;
}

export interface CrawlStats {
  /** unique URLs discovered (queued), whether or not they were fetched */
  pagesDiscovered: number;
  /** pages successfully fetched and stored */
  pagesScanned: number;
  /** true when maxPages truncated discovery — coverage is partial */
  capped: boolean;
}

export interface PageStore {
  /** look up a page by URL (normalized internally) */
  get(url: string): CrawledPage | undefined;
  all(): CrawledPage[];
  /** pages whose content-type is HTML — what most checks iterate */
  htmlPages(): CrawledPage[];
  stats(): CrawlStats;
}
```

- [ ] **Step 6: Write `tests/helpers/page-store.ts`**

```ts
import { normalizePageUrl } from "../../src/crawl/url.js";
import type { CrawledPage, CrawlStats, PageStore } from "../../src/types.js";

export function fixturePage(page: Partial<CrawledPage> & { url: string }): CrawledPage {
  const url = normalizePageUrl(page.url) ?? page.url;
  return {
    finalUrl: url,
    status: 200,
    ok: true,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<html></html>",
    redirected: false,
    durationMs: 1,
    ...page,
    url,
  };
}

export function fixturePageStore(
  pages: Array<Partial<CrawledPage> & { url: string }> = [],
  stats: Partial<CrawlStats> = {},
): PageStore {
  const records = pages.map(fixturePage);
  const byUrl = new Map(records.map((record) => [record.url, record]));
  return {
    get: (url) => byUrl.get(normalizePageUrl(url) ?? url),
    all: () => [...records],
    htmlPages: () =>
      records.filter((record) => (record.headers["content-type"] ?? "").includes("text/html")),
    stats: () => ({
      pagesDiscovered: records.length,
      pagesScanned: records.length,
      capped: false,
      ...stats,
    }),
  };
}
```

- [ ] **Step 7: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/crawl-url.test.ts` — Expected: PASS (4 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/crawl/url.ts src/types.ts tests/helpers/page-store.ts tests/crawl-url.test.ts
git commit -m "feat: add URL normalization and PageStore contract types"
```

---

### Task 2: Link extraction (adds cheerio)

**Files:**

- Create: `src/crawl/extract-links.ts`
- Modify: `package.json` (add cheerio)
- Test: `tests/extract-links.test.ts`

**Interfaces:**

- Consumes: `normalizePageUrl` from `src/crawl/url.ts`
- Produces: `extractLinks(html: string, pageUrl: string): string[]` — deduped, normalized, http(s)-only anchor hrefs (cross-origin included; the crawler filters origins, PR 5's link check wants externals too).

- [ ] **Step 1: Install cheerio**

```bash
npm install cheerio
```

(cheerio is named in the approved spec's stack list — pre-vetted. Note its addition in your report.)

- [ ] **Step 2: Write the failing test** — `tests/extract-links.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/crawl/extract-links.js";

describe("extractLinks", () => {
  it("extracts, resolves, normalizes, and dedupes anchor hrefs", () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="/about#team">Team</a>
      <a href="contact.html">Contact</a>
      <a href="https://other.example/page">External</a>
      <a href="mailto:a@b.c">Mail</a>
      <a href="javascript:void(0)">JS</a>
      <a>no href</a>
    </body></html>`;
    expect(extractLinks(html, "https://example.com/dir/index.html").sort()).toEqual([
      "https://example.com/about",
      "https://example.com/dir/contact.html",
      "https://other.example/page",
    ]);
  });

  it("returns an empty array for HTML without links and for junk input", () => {
    expect(extractLinks("<p>plain</p>", "https://example.com/")).toEqual([]);
    expect(extractLinks("%%%not-html%%%", "https://example.com/")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/extract-links.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Write `src/crawl/extract-links.ts`**

```ts
import { load } from "cheerio";
import { normalizePageUrl } from "./url.js";

/**
 * Extract every crawlable link from a page. Returns normalized http(s) URLs,
 * deduped, including cross-origin ones — callers decide which origins to follow.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const links = new Set<string>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const normalized = normalizePageUrl(href, pageUrl);
    if (normalized !== undefined) links.add(normalized);
  });
  return [...links];
}
```

- [ ] **Step 5: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/extract-links.test.ts` — Expected: PASS (2 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/crawl/extract-links.ts tests/extract-links.test.ts
git commit -m "feat: add anchor link extraction via cheerio"
```

---

### Task 3: Sitemap seeding

**Files:**

- Create: `src/crawl/sitemap.ts`
- Test: `tests/sitemap.test.ts`

**Interfaces:**

- Consumes: `RateLimitedFetch` from `src/types.ts`; `normalizePageUrl` from `src/crawl/url.ts`; test helper `startServer` from `tests/helpers/server.ts`
- Produces: `fetchSitemapUrls(fetchFn: RateLimitedFetch, origin: string, limit?: number): Promise<string[]>` — same-origin page URLs from `<origin>/sitemap.xml`; supports plain `<urlset>` and one level of `<sitemapindex>` (max 10 child sitemaps); returns `[]` on absence, non-200, fetch error, or unparseable XML (sitemap is a seed source, never a failure).

- [ ] **Step 1: Write the failing test** — `tests/sitemap.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../src/fetch/fetcher.js";
import { fetchSitemapUrls } from "../src/crawl/sitemap.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const urlset = (origin: string) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/about#frag</loc></url>
  <url><loc>https://elsewhere.invalid/page</loc></url>
</urlset>`;

describe("fetchSitemapUrls", () => {
  it("returns normalized same-origin URLs from a urlset sitemap", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(urlset(`http://127.0.0.1:${new URL(server?.url ?? "").port}`));
      } else res.end("ok");
    });
    const urls = await fetchSitemapUrls(createFetcher(), server.url);
    expect(urls).toEqual([`${server.url}/`, `${server.url}/about`]);
  });

  it("follows one level of sitemapindex", async () => {
    server = await startServer((req, res) => {
      const origin = server?.url ?? "";
      res.setHeader("content-type", "application/xml");
      if (req.url === "/sitemap.xml") {
        res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap>
          <sitemap><loc>https://elsewhere.invalid/other.xml</loc></sitemap>
        </sitemapindex>`);
      } else if (req.url === "/sitemap-pages.xml") {
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${origin}/deep</loc></url>
        </urlset>`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    expect(await fetchSitemapUrls(createFetcher(), server.url)).toEqual([`${server.url}/deep`]);
  });

  it("returns [] when the sitemap is missing or malformed", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") res.end("%%% not xml %%%");
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    expect(await fetchSitemapUrls(createFetcher(), server.url)).toEqual([]);
    const missing = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    try {
      expect(await fetchSitemapUrls(createFetcher(), missing.url)).toEqual([]);
    } finally {
      await missing.close();
    }
  });

  it("caps the number of returned URLs at the limit", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        const origin = server?.url ?? "";
        const entries = Array.from(
          { length: 20 },
          (_v, i) => `<url><loc>${origin}/p${String(i)}</loc></url>`,
        ).join("");
        res.setHeader("content-type", "application/xml");
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
        );
      } else res.end("ok");
    });
    expect(await fetchSitemapUrls(createFetcher(), server.url, 5)).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sitemap.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/crawl/sitemap.ts`**

```ts
import { load } from "cheerio";
import type { RateLimitedFetch } from "../types.js";
import { normalizePageUrl } from "./url.js";

const MAX_CHILD_SITEMAPS = 10;

interface ParsedSitemap {
  pageUrls: string[];
  childSitemaps: string[];
}

function parseSitemapXml(xml: string): ParsedSitemap {
  const $ = load(xml, { xml: true });
  const text = (selector: string): string[] =>
    $(selector)
      .map((_index, element) => $(element).text().trim())
      .get()
      .filter((value) => value !== "");
  return {
    pageUrls: text("urlset > url > loc"),
    childSitemaps: text("sitemapindex > sitemap > loc"),
  };
}

/**
 * Seed URLs from <origin>/sitemap.xml. Supports a plain urlset and one level
 * of sitemapindex. Only same-origin page URLs are returned. Absence, errors,
 * and malformed XML all yield [] — a sitemap is a seed source, never a failure.
 */
export async function fetchSitemapUrls(
  fetchFn: RateLimitedFetch,
  origin: string,
  limit = 500,
): Promise<string[]> {
  const collected: string[] = [];
  const sameOrigin = (raw: string): string | undefined => {
    const normalized = normalizePageUrl(raw);
    if (normalized === undefined) return undefined;
    return new URL(normalized).origin === new URL(origin).origin ? normalized : undefined;
  };

  let root: ParsedSitemap;
  try {
    const response = await fetchFn(new URL("/sitemap.xml", origin).href);
    if (response.status !== 200) return [];
    root = parseSitemapXml(response.body);
  } catch {
    return [];
  }

  const pagePool = [...root.pageUrls];
  for (const child of root.childSitemaps.slice(0, MAX_CHILD_SITEMAPS)) {
    if (pagePool.length >= limit) break;
    const childUrl = sameOrigin(child);
    if (childUrl === undefined) continue;
    try {
      const response = await fetchFn(childUrl);
      if (response.status === 200) pagePool.push(...parseSitemapXml(response.body).pageUrls);
    } catch {
      // skip unreachable child sitemaps
    }
  }

  const seen = new Set<string>();
  for (const raw of pagePool) {
    const url = sameOrigin(raw);
    if (url !== undefined && !seen.has(url)) {
      seen.add(url);
      collected.push(url);
      if (collected.length >= limit) break;
    }
  }
  return collected;
}
```

- [ ] **Step 4: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/sitemap.test.ts` — Expected: PASS (4 tests). Note: the first test's handler references `server.url` before `startServer` resolves — cheerio's handler runs per-request (after resolution), so this is safe; if TypeScript complains about use-before-assign, hoist a `let origin = ""` set after `startServer` returns and use it in the handler.
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/crawl/sitemap.ts tests/sitemap.test.ts
git commit -m "feat: add sitemap.xml seed-URL fetching with sitemapindex support"
```

---

### Task 4: Crawler and SitePageStore

**Files:**

- Create: `src/crawl/crawler.ts`
- Test: `tests/crawler.test.ts`

**Interfaces:**

- Consumes: `extractLinks`, `fetchSitemapUrls`, `normalizePageUrl`; types `CrawledPage`, `CrawlStats`, `PageStore`, `RateLimitedFetch`; test helper `startServer`.
- Produces: `crawlSite(options: CrawlOptions): Promise<PageStore>` with `interface CrawlOptions { baseUrl: string; fetch: RateLimitedFetch; maxPages?: number; concurrency?: number }` (defaults 200 / 5). Task 5 calls this from `runReview`.

Behavior contract:

- Seeds: normalized base URL first, then sitemap URLs.
- Allowed origins: the base URL's origin, plus its https twin when the base is http (mirrors the fetcher's upgrade-following policy).
- Links are followed only from stored pages with an HTML content-type and status < 400.
- `maxPages` caps _discovery_: once the queued-URL set reaches `maxPages`, further URLs are dropped and `capped` becomes true.
- A page whose fetch throws (after the fetcher's single retry) is counted as discovered but not scanned, and is not stored.
- Throws `Error("Invalid base URL: …")` for an unusable base URL. Individual page failures never throw.

- [ ] **Step 1: Write the failing test** — `tests/crawler.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { crawlSite } from "../src/crawl/crawler.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const page = (links: string[]) =>
  `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

function siteHandler(routes: Record<string, { body: string; type?: string; status?: number }>) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const route = routes[req.url ?? "/"];
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = route.status ?? 200;
    res.setHeader("content-type", route.type ?? "text/html; charset=utf-8");
    res.end(route.body);
  };
}

describe("crawlSite", () => {
  it("BFS-crawls same-origin links and records pages", async () => {
    server = await startServer(
      siteHandler({
        "/": { body: page(["/a", "/b", "https://elsewhere.invalid/x"]) },
        "/a": { body: page(["/b", "/"]) },
        "/b": { body: page([]) },
      }),
    );
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher() });
    const urls = store
      .all()
      .map((p) => new URL(p.url).pathname)
      .sort();
    expect(urls).toEqual(["/", "/a", "/b"]);
    expect(store.get(`${server.url}/a`)?.status).toBe(200);
    expect(store.stats()).toEqual({ pagesDiscovered: 3, pagesScanned: 3, capped: false });
  });

  it("seeds from sitemap.xml in addition to the base URL", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${server?.url ?? ""}/orphan</loc></url></urlset>`,
        );
        return;
      }
      siteHandler({
        "/": { body: page([]) },
        "/orphan": { body: page([]) },
      })(req, res);
    });
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher() });
    expect(store.get(`${server.url}/orphan`)?.status).toBe(200);
  });

  it("caps discovery at maxPages and reports capped", async () => {
    const links = Array.from({ length: 10 }, (_v, i) => `/p${String(i)}`);
    const routes: Record<string, { body: string }> = { "/": { body: page(links) } };
    for (const l of links) routes[l] = { body: page([]) };
    server = await startServer(siteHandler(routes));
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher(), maxPages: 4 });
    const stats = store.stats();
    expect(stats.capped).toBe(true);
    expect(stats.pagesDiscovered).toBe(4);
    expect(stats.pagesScanned).toBe(4);
  });

  it("does not extract links from non-HTML or error responses", async () => {
    server = await startServer(
      siteHandler({
        "/": { body: page(["/data.json", "/broken"]) },
        "/data.json": { body: `{"a":"<a href='/never'>x</a>"}`, type: "application/json" },
        "/broken": { body: page(["/also-never"]), status: 500 },
      }),
    );
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher() });
    const paths = store.all().map((p) => new URL(p.url).pathname);
    expect(paths).not.toContain("/never");
    expect(paths).not.toContain("/also-never");
    expect(store.get(`${server.url}/broken`)?.status).toBe(500);
    expect(store.htmlPages().map((p) => new URL(p.url).pathname)).not.toContain("/data.json");
  });

  it("counts unfetchable pages as discovered but not scanned", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/dies") {
        req.socket.destroy();
        return;
      }
      siteHandler({ "/": { body: page(["/dies"]) } })(req, res);
    });
    const store = await crawlSite({
      baseUrl: server.url,
      fetch: createFetcher({ timeoutMs: 500 }),
    });
    const stats = store.stats();
    expect(stats.pagesDiscovered).toBe(2);
    expect(stats.pagesScanned).toBe(1);
    expect(store.get(`${server.url}/dies`)).toBeUndefined();
  });

  it("throws for an invalid base URL", async () => {
    await expect(crawlSite({ baseUrl: "not a url", fetch: createFetcher() })).rejects.toThrow(
      "Invalid base URL",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crawler.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/crawl/crawler.ts`**

```ts
import type {
  CrawledPage,
  CrawlStats,
  FetchResult,
  PageStore,
  RateLimitedFetch,
} from "../types.js";
import { extractLinks } from "./extract-links.js";
import { fetchSitemapUrls } from "./sitemap.js";
import { normalizePageUrl } from "./url.js";

export interface CrawlOptions {
  baseUrl: string;
  fetch: RateLimitedFetch;
  /** discovery cap; crawl truncates (and flags capped) beyond this */
  maxPages?: number;
  /** simultaneous page fetches inside the crawl loop */
  concurrency?: number;
}

class SitePageStore implements PageStore {
  private readonly pages = new Map<string, CrawledPage>();
  constructor(private readonly crawlStats: CrawlStats) {}

  set(page: CrawledPage): void {
    this.pages.set(page.url, page);
  }
  get(url: string): CrawledPage | undefined {
    const normalized = normalizePageUrl(url);
    return normalized === undefined ? undefined : this.pages.get(normalized);
  }
  all(): CrawledPage[] {
    return [...this.pages.values()];
  }
  htmlPages(): CrawledPage[] {
    return this.all().filter((page) => (page.headers["content-type"] ?? "").includes("text/html"));
  }
  stats(): CrawlStats {
    return { ...this.crawlStats };
  }
}

function allowedOriginsFor(base: URL): Set<string> {
  const origins = new Set([base.origin]);
  if (base.protocol === "http:") {
    const upgraded = new URL(base.href);
    upgraded.protocol = "https:";
    upgraded.port = "";
    origins.add(upgraded.origin);
  }
  return origins;
}

export async function crawlSite(options: CrawlOptions): Promise<PageStore> {
  const { fetch: fetchFn, maxPages = 200, concurrency = 5 } = options;
  const base = normalizePageUrl(options.baseUrl);
  if (base === undefined) throw new Error(`Invalid base URL: ${options.baseUrl}`);

  const allowedOrigins = allowedOriginsFor(new URL(base));
  const stats: CrawlStats = { pagesDiscovered: 0, pagesScanned: 0, capped: false };
  const store = new SitePageStore(stats);

  const discovered = new Set<string>();
  const queue: string[] = [];
  const enqueue = (url: string): void => {
    if (discovered.has(url)) return;
    if (!allowedOrigins.has(new URL(url).origin)) return;
    if (discovered.size >= maxPages) {
      stats.capped = true;
      return;
    }
    discovered.add(url);
    stats.pagesDiscovered = discovered.size;
    queue.push(url);
  };

  enqueue(base);
  for (const url of await fetchSitemapUrls(fetchFn, new URL(base).origin)) enqueue(url);

  const visit = async (url: string): Promise<void> => {
    let result: FetchResult;
    try {
      result = await fetchFn(url);
    } catch {
      return; // discovered but not scanned; the fetcher already retried once
    }
    store.set({
      url,
      finalUrl: result.url,
      status: result.status,
      ok: result.ok,
      headers: result.headers,
      body: result.body,
      redirected: result.redirected,
      durationMs: result.durationMs,
    });
    stats.pagesScanned += 1;
    const isHtml = (result.headers["content-type"] ?? "").includes("text/html");
    if (isHtml && result.status < 400) {
      for (const link of extractLinks(result.body, result.url)) enqueue(link);
    }
  };

  await new Promise<void>((resolvePromise) => {
    let inFlight = 0;
    const pump = (): void => {
      if (queue.length === 0 && inFlight === 0) {
        resolvePromise();
        return;
      }
      while (inFlight < concurrency && queue.length > 0) {
        const url = queue.shift();
        if (url === undefined) break;
        inFlight += 1;
        void visit(url).finally(() => {
          inFlight -= 1;
          pump();
        });
      }
    };
    pump();
  });

  return store;
}
```

- [ ] **Step 4: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/crawler.test.ts` — Expected: PASS (6 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/crawl/crawler.ts tests/crawler.test.ts
git commit -m "feat: add same-origin BFS crawler with sitemap seeding and page cap"
```

---

### Task 5: Wire PageStore into the engine (CheckContext.pages)

**Files:**

- Modify: `src/types.ts` (`CheckContext`), `src/engine/run-review.ts`, `src/checks/functionality/reachable.ts`
- Test (modify): `tests/runner.test.ts`, `tests/check-reachable.test.ts`, `tests/run-review.test.ts`

**Interfaces:**

- Consumes: `crawlSite` (Task 4), `fixturePageStore` (Task 1).
- Produces: `CheckContext.pages: PageStore` — every check (and Task 6's crawl-coverage) reads crawl results from here. Report schema is untouched in this task (that's Task 7).

- [ ] **Step 1: Add `pages` to `CheckContext` in `src/types.ts`**

```ts
export interface CheckContext {
  baseUrl: string;
  environment: Environment;
  config: ResolvedConfig;
  /** crawl results shared by all checks — one fetch per page for the whole run */
  pages: PageStore;
  fetch: RateLimitedFetch;
  logger: Logger;
}
```

- [ ] **Step 2: Run typecheck to see every construction site that must change**

Run: `npm run typecheck`
Expected: FAIL in `src/engine/run-review.ts` (runChecks base) and in tests that build contexts (`tests/runner.test.ts`, `tests/check-reachable.test.ts`).

- [ ] **Step 3: Crawl in `src/engine/run-review.ts`**

Add imports:

```ts
import { crawlSite } from "../crawl/crawler.js";
```

After the HEAD-preflight `try/catch` (which stays — it is the deliberate unreachable-gate), insert:

```ts
const pages = await crawlSite({
  baseUrl: options.url,
  fetch: fetchFn,
  maxPages: config.maxPages,
});
```

and extend the `runChecks` base context:

```ts
const executed = await runChecks(toRun, {
  baseUrl: options.url,
  environment: config.environment,
  config,
  pages,
  fetch: fetchFn,
});
```

- [ ] **Step 4: Make `functionality.reachable` read from the store** — replace the `run` body in `src/checks/functionality/reachable.ts`

```ts
  async run(ctx) {
    const page = ctx.pages.get(ctx.baseUrl);
    const result = page ?? (await ctx.fetch(ctx.baseUrl));
    ctx.logger.debug("Base URL result", {
      status: result.status,
      fromCrawl: page !== undefined,
      durationMs: result.durationMs,
    });
```

Keep the existing 3xx and >=400 handling exactly as-is below this (both `CrawledPage` and `FetchResult` expose `status` and `headers`, which is all that logic uses).

- [ ] **Step 5: Fix the failing test constructions**

In `tests/runner.test.ts` and `tests/check-reachable.test.ts`, add to the context objects:

```ts
import { fixturePageStore } from "./helpers/page-store.js";
// in the context literal:
  pages: fixturePageStore(),
```

In `tests/check-reachable.test.ts`, the existing tests fetch live servers — with an empty fixture store the check falls back to `ctx.fetch`, so they still pass unchanged apart from the added `pages` field. Add one new test proving the store is preferred:

```ts
it("prefers the crawled page over a fresh fetch", async () => {
  const outcome = await reachableCheck.run({
    ...contextFor("http://unused.invalid"),
    baseUrl: "http://unused.invalid",
    fetch: () => Promise.reject(new Error("must not fetch")),
    pages: fixturePageStore([{ url: "http://unused.invalid/" }]),
  });
  expect(outcome).toEqual({ score: 100, findings: [] });
});
```

(Note: `fixturePageStore` normalizes `http://unused.invalid` → `http://unused.invalid/`, and `PageStore.get` normalizes lookups, so the base URL matches with or without the trailing slash.)

In `tests/run-review.test.ts`, the "healthy site" servers respond `res.end("<html></html>")` with no content-type — the crawler still stores the page (reachable reads it); no test changes should be needed beyond what typecheck demands. Run and fix only what fails.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run` — Expected: all tests PASS.
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/run-review.ts src/checks/functionality/reachable.ts tests/
git commit -m "feat: crawl the site once per run and expose PageStore to all checks"
```

---

### Task 6: functionality.crawl-coverage check

**Files:**

- Create: `src/checks/functionality/crawl-coverage.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-crawl-coverage.test.ts`

**Interfaces:**

- Consumes: `CheckContext.pages` (Task 5), `fixturePageStore` (Task 1).
- Produces: `crawlCoverageCheck: Check` (id `functionality.crawl-coverage`, non-blocking, weight 1, all environments), registered in `builtinChecks`.

- [ ] **Step 1: Write the failing test** — `tests/check-crawl-coverage.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { crawlCoverageCheck } from "../src/checks/functionality/crawl-coverage.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const config: ResolvedConfig = {
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks: {},
  customChecks: [],
};

const contextWith = (pages: CheckContext["pages"]): CheckContext => ({
  baseUrl: "https://example.com",
  environment: "local",
  config,
  pages,
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  logger: { debug: () => undefined },
});

describe("functionality.crawl-coverage", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((c) => c.id)).toContain("functionality.crawl-coverage");
  });

  it("passes when the crawl was not capped", async () => {
    const outcome = await crawlCoverageCheck.run(
      contextWith(fixturePageStore([{ url: "https://example.com/" }])),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns with partial-coverage guidance when the crawl was capped", async () => {
    const outcome = await crawlCoverageCheck.run(
      contextWith(fixturePageStore([{ url: "https://example.com/" }], { capped: true })),
    );
    expect(outcome.score).toBe(50);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.message).toContain("200");
    expect(outcome.findings[0]?.recommendation).toContain("maxPages");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check-crawl-coverage.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/functionality/crawl-coverage.ts`**

```ts
import type { Check } from "../../types.js";

export const crawlCoverageCheck: Check = {
  id: "functionality.crawl-coverage",
  category: "functionality",
  description: "The crawl covered the discoverable site without hitting the page cap.",
  environments: ["local", "ci", "production"],
  blocking: false,
  weight: 1,
  run(ctx) {
    const stats = ctx.pages.stats();
    ctx.logger.debug("Crawl stats", stats);
    if (stats.capped) {
      return Promise.resolve({
        score: 50,
        findings: [
          {
            severity: "warning" as const,
            message: `Crawl discovery hit the ${String(ctx.config.maxPages)} page cap after scanning ${String(stats.pagesScanned)} pages — results cover only part of the site.`,
            recommendation:
              "Raise maxPages in the config (or --max-pages) to cover the full site, or scope the review to a smaller section. Do not treat this report as full-site coverage.",
          },
        ],
      });
    }
    return Promise.resolve({ score: 100, findings: [] });
  },
};
```

- [ ] **Step 4: Register it** — `src/engine/registry.ts`

```ts
import { crawlCoverageCheck } from "../checks/functionality/crawl-coverage.js";
import { reachableCheck } from "../checks/functionality/reachable.js";
import type { Check } from "../types.js";

export const builtinChecks: Check[] = [reachableCheck, crawlCoverageCheck];
```

- [ ] **Step 5: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/check-crawl-coverage.test.ts` — Expected: PASS (3 tests).
Run: `npm run format && npm run verify` — Expected: green (existing run-review tests already tolerate additional checks; fix any fixture expectations that assumed exactly one check if they fail).

- [ ] **Step 6: Commit**

```bash
git add src/checks/functionality/crawl-coverage.ts src/engine/registry.ts tests/check-crawl-coverage.test.ts
git commit -m "feat: add crawl-coverage check warning on capped crawls"
```

---

### Task 7: Report v2 — crawl block, console line, README, PR

**Files:**

- Modify: `src/report/schema.ts`, `src/engine/run-review.ts`, `src/reporters/console.ts`, `README.md`
- Test (modify): `tests/report-schema.test.ts`, `tests/reporters.test.ts`, `tests/run-review.test.ts`

**Interfaces:**

- Consumes: `PageStore.stats()` (Task 4 via Task 5).
- Produces: `REPORT_VERSION = 2`; `ReviewReport.crawl: { pagesDiscovered: number; pagesScanned: number; capped: boolean }`.

- [ ] **Step 1: Update the schema tests first** — in `tests/report-schema.test.ts`:
  - change `reportVersion: 1` in `validReport` to `reportVersion: 2`
  - add to `validReport` (after `durationMs`): `crawl: { pagesDiscovered: 43, pagesScanned: 43, capped: false },`
  - change the pin test to `expect(REPORT_VERSION).toBe(2);`
  - add one rejection test:

```ts
it("rejects a report missing the crawl block", () => {
  const { crawl: _crawl, ...withoutCrawl } = validReport;
  expect(() => reviewReportSchema.parse(withoutCrawl)).toThrow();
});
```

- [ ] **Step 2: Run to verify the new expectations fail**

Run: `npx vitest run tests/report-schema.test.ts` — Expected: FAIL (version pin + missing crawl field).

- [ ] **Step 3: Update `src/report/schema.ts`**

```ts
export const REPORT_VERSION = 2;

export const crawlStatsSchema = z.object({
  pagesDiscovered: z.number().int().min(0),
  pagesScanned: z.number().int().min(0),
  capped: z.boolean(),
});
```

and add to `reviewReportSchema` after `durationMs`:

```ts
  crawl: crawlStatsSchema,
```

- [ ] **Step 4: Emit stats from `src/engine/run-review.ts`** — in the report literal, after `durationMs`:

```ts
    crawl: pages.stats(),
```

- [ ] **Step 5: Console reporter line** — in `src/reporters/console.ts`, after the `Environment:` line push:

```ts
lines.push(
  `Crawl: ${String(report.crawl.pagesScanned)}/${String(report.crawl.pagesDiscovered)} pages scanned${report.crawl.capped ? " (CAPPED — partial coverage)" : ""}`,
);
```

- [ ] **Step 6: Fix remaining test fixtures**

- `tests/reporters.test.ts`: the fixture report needs `reportVersion: 2` (as a literal it may need updating to satisfy the `ReviewReport` type) and `crawl: { pagesDiscovered: 5, pagesScanned: 5, capped: false }`; add an assertion `expect(text).toContain("5/5 pages scanned");`
- `tests/run-review.test.ts`: add to the healthy-site test: `expect(report.crawl.pagesScanned).toBeGreaterThanOrEqual(1);`

Run: `npx vitest run` — Expected: all PASS.

- [ ] **Step 7: README** — in the API section's example output notes (or after the config example), add:

```markdown
## Crawling

Every run crawls the target site once — same-origin BFS seeded from the base
URL and `sitemap.xml` — up to `maxPages` (default 200, `--max-pages` on the
CLI). Checks read the shared crawl results instead of re-fetching pages. The
report's `crawl` block (`pagesDiscovered` / `pagesScanned` / `capped`) tells
you whether coverage was complete; a capped crawl also surfaces as a
`functionality.crawl-coverage` warning.
```

- [ ] **Step 8: Full verification and live smoke test**

Run: `npm run format && npm run verify` — Expected: green.
Run: `npm run build && node dist/cli.js https://example.com --env production --format console` (or a local server if offline) — Expected: console output includes the `Crawl:` line and a `functionality.crawl-coverage` check.

- [ ] **Step 9: Commit and open PR 3**

```bash
git add -A
git commit -m "feat: report crawl coverage stats (report schema v2)"
git push -u origin feat/crawler
gh pr create --base main --title "feat: crawler + PageStore (PR 3)" --body "PR 3 of the roadmap: same-origin BFS crawler with sitemap seeding, shared PageStore on CheckContext, functionality.crawl-coverage check, and crawl stats in the report (REPORT_VERSION 2).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## After this plan

PR 4 (`seo.meta-tags`) iterates `ctx.pages.htmlPages()` — no crawling code of its own. The `REPORT_VERSION` bump to 2 is a breaking schema change for report consumers; PR 3's merge notes should call it out.
