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
