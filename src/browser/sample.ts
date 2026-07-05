import { normalizePageUrl } from "../crawl/url.js";
import type { CrawledPage } from "../types.js";

const isSampleable = (page: CrawledPage): boolean =>
  page.status >= 200 &&
  page.status < 300 &&
  (page.headers["content-type"] ?? "").includes("text/html");

/**
 * Choose which pages the browser checks visit: the base page first (if it was
 * crawled and sampleable), then up to `size` more sampleable pages in crawl
 * order. Deduped by URL; total length ≤ size + 1.
 */
export function samplePages(pages: CrawledPage[], baseUrl: string, size: number): CrawledPage[] {
  const base = normalizePageUrl(baseUrl);
  const sampleable = pages.filter(isSampleable);
  const result: CrawledPage[] = [];
  const seen = new Set<string>();

  const basePage = sampleable.find((page) => page.url === base);
  if (basePage !== undefined) {
    result.push(basePage);
    seen.add(basePage.url);
  }
  const maxResults = basePage ? size + 1 : size;
  for (const page of sampleable) {
    if (result.length >= maxResults) break;
    if (seen.has(page.url)) continue;
    result.push(page);
    seen.add(page.url);
  }
  return result;
}
