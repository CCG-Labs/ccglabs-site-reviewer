import { load } from "cheerio";
import type { RateLimitedFetch } from "../types.js";
import { normalizePageUrl } from "./url.js";

const MAX_CHILD_SITEMAPS = 10;

interface ParsedSitemap {
  pageUrls: string[];
  childSitemaps: string[];
}

export function parseSitemapXml(xml: string): ParsedSitemap {
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

/** Fetch and parse one sitemap (following one level of sitemapindex). [] on any failure. */
async function fetchOneSitemapPageUrls(
  fetchFn: RateLimitedFetch,
  sitemapUrl: string,
  sameOrigin: (raw: string) => string | undefined,
  limit: number,
): Promise<string[]> {
  let root: ParsedSitemap;
  try {
    const response = await fetchFn(sitemapUrl);
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
  return pagePool;
}

/**
 * Seed URLs from every sitemap in `sitemapUrls` (resolve which ones those are
 * with `resolveSitemapUrls` first — this function no longer guesses). Supports
 * a plain urlset and one level of sitemapindex per sitemap. Only page URLs
 * within `allowedOrigins` are returned. Absence, errors, and malformed XML on
 * any individual sitemap yield no entries from that sitemap — a sitemap is a
 * seed source, never a failure.
 */
export async function fetchSitemapUrls(
  fetchFn: RateLimitedFetch,
  sitemapUrls: string[],
  limit: number,
  allowedOrigins: ReadonlySet<string>,
): Promise<string[]> {
  const sameOrigin = (raw: string): string | undefined => {
    const normalized = normalizePageUrl(raw);
    if (normalized === undefined) return undefined;
    return allowedOrigins.has(new URL(normalized).origin) ? normalized : undefined;
  };

  const collected: string[] = [];
  const seen = new Set<string>();
  for (const sitemapUrl of sitemapUrls) {
    if (collected.length >= limit) break;
    const pageUrls = await fetchOneSitemapPageUrls(fetchFn, sitemapUrl, sameOrigin, limit);
    for (const raw of pageUrls) {
      const url = sameOrigin(raw);
      if (url !== undefined && !seen.has(url)) {
        seen.add(url);
        collected.push(url);
        if (collected.length >= limit) break;
      }
    }
  }
  return collected;
}
