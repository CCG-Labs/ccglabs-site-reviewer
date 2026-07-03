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
