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
