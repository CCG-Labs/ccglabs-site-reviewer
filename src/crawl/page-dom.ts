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
