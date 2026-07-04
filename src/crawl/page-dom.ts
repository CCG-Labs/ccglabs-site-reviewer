import { load, type CheerioAPI } from "cheerio";
import type { CrawledPage } from "../types.js";

const cache = new WeakMap<CrawledPage, CheerioAPI>();

/**
 * One parsed DOM per crawled page per run. Checks share the handle instead of
 * re-parsing the same HTML (previously up to 4 cheerio parses per page).
 *
 * Parsed DOMs are retained for the run's lifetime in a WeakMap keyed by the
 * store-held CrawledPage objects, so the memory envelope is bounded by
 * maxPages × body size × DOM overhead. That trade buys back roughly 4x
 * per-page parse CPU versus re-parsing per check.
 */
export function pageDom(page: CrawledPage): CheerioAPI {
  const cached = cache.get(page);
  if (cached !== undefined) return cached;
  const parsed = load(page.body);
  cache.set(page, parsed);
  return parsed;
}
