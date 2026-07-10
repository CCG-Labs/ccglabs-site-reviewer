import { load } from "cheerio";
import { BodySizeCapError } from "../fetch/fetcher.js";
import type { RateLimitedFetch } from "../types.js";
import { normalizePageUrl } from "./url.js";

// Declared child sitemaps beyond this are never even attempted, regardless of maxEntries.
export const MAX_CHILD_SITEMAPS = 10;

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

export interface SitemapWalkResult {
  exists: boolean;
  failure: string | undefined;
  /** merged page URLs from this document plus any successfully-walked children, capped at maxEntries */
  pageUrls: string[];
  /** raw <url> count in the top-level document, before maxEntries is applied — for spec size checks */
  rootPageUrlCount: number;
  /** raw <sitemap> count in the top-level document, before slicing to MAX_CHILD_SITEMAPS — for spec size checks */
  declaredChildSitemaps: number;
  /** child sitemaps eligible to be walked (declaredChildSitemaps, capped at MAX_CHILD_SITEMAPS) */
  totalChildSitemaps: number;
  /** of totalChildSitemaps, how many were actually visited before maxEntries was hit */
  visitedChildSitemaps: number;
  /** of visitedChildSitemaps, how many were skipped without fetching (different origin / invalid URL) */
  crossOriginChildSitemaps: number;
  /** of visitedChildSitemaps, how many were fetched (same-origin) but failed */
  failedChildSitemaps: number;
  /** largest single successfully-fetched child's raw <url> count (0 if none) — `pageUrls` is
   *  capped at maxEntries, so a spec size check on an individual child needs this separately */
  maxChildPageUrlCount: number;
}

const EMPTY_WALK: Omit<SitemapWalkResult, "exists" | "failure"> = {
  pageUrls: [],
  rootPageUrlCount: 0,
  declaredChildSitemaps: 0,
  totalChildSitemaps: 0,
  visitedChildSitemaps: 0,
  crossOriginChildSitemaps: 0,
  failedChildSitemaps: 0,
  maxChildPageUrlCount: 0,
};

/**
 * Fetch and parse one sitemap, following one level of sitemapindex. Shared by crawl seeding
 * (`fetchSitemapUrls`, which only needs `pageUrls`) and `seo.sitemap-robots` (which needs the
 * full reachability/size bookkeeping too) so both walk sitemaps identically — including the
 * MAX_CHILD_SITEMAPS cap and per-child fetch/error handling — instead of maintaining two
 * independent implementations that can silently drift apart.
 *
 * Child sitemaps are fetched concurrently (not one at a time): a slow/hanging child no longer
 * stacks its timeout on top of every other child's. Results are still evaluated in declaration
 * order so the maxEntries early-exit stays meaningful (`visitedChildSitemaps` reflects what was
 * actually looked at, not the full declared/capped count).
 */
export async function walkSitemap(
  fetchFn: RateLimitedFetch,
  sitemapUrl: string,
  allowed: ReadonlySet<string>,
  maxEntries: number,
): Promise<SitemapWalkResult> {
  let response;
  try {
    response = await fetchFn(sitemapUrl);
  } catch (error) {
    // BodySizeCapError means the shared fetcher's response-size cap was hit — give an
    // actionable message instead of a generic one (the sitemaps.org spec's own 50MB-per-file
    // cap is well above this tool's cap, so a real oversized sitemap always fails here first).
    const failure =
      error instanceof BodySizeCapError
        ? `too large to fetch — exceeds this tool's response size cap (${error.message})`
        : error instanceof Error
          ? error.message
          : String(error);
    return { exists: false, failure, ...EMPTY_WALK };
  }
  if (response.status !== 200) {
    return { exists: false, failure: `HTTP ${String(response.status)}`, ...EMPTY_WALK };
  }

  const root = parseSitemapXml(response.body);
  const pageUrls = [...root.pageUrls];
  const childSitemaps = root.childSitemaps.slice(0, MAX_CHILD_SITEMAPS);

  const childFetches = childSitemaps.map(
    async (
      child,
    ): Promise<
      { kind: "cross-origin" } | { kind: "failed" } | { kind: "ok"; parsed: ParsedSitemap }
    > => {
      // never send requests (which carry configured auth headers) to foreign origins
      const childUrl = normalizePageUrl(child);
      if (childUrl === undefined || !allowed.has(new URL(childUrl).origin)) {
        return { kind: "cross-origin" };
      }
      try {
        const childResponse = await fetchFn(childUrl);
        if (childResponse.status === 200) {
          return { kind: "ok", parsed: parseSitemapXml(childResponse.body) };
        }
        return { kind: "failed" };
      } catch {
        return { kind: "failed" };
      }
    },
  );

  let visitedChildSitemaps = 0;
  let crossOriginChildSitemaps = 0;
  let failedChildSitemaps = 0;
  let maxChildPageUrlCount = 0;
  for (const childFetch of childFetches) {
    if (pageUrls.length >= maxEntries) break;
    visitedChildSitemaps += 1;
    const result = await childFetch;
    if (result.kind === "cross-origin") crossOriginChildSitemaps += 1;
    else if (result.kind === "failed") failedChildSitemaps += 1;
    else {
      pageUrls.push(...result.parsed.pageUrls);
      maxChildPageUrlCount = Math.max(maxChildPageUrlCount, result.parsed.pageUrls.length);
    }
  }

  return {
    exists: true,
    failure: undefined,
    pageUrls: pageUrls.slice(0, maxEntries),
    rootPageUrlCount: root.pageUrls.length,
    declaredChildSitemaps: root.childSitemaps.length,
    totalChildSitemaps: childSitemaps.length,
    visitedChildSitemaps,
    crossOriginChildSitemaps,
    failedChildSitemaps,
    maxChildPageUrlCount,
  };
}

/**
 * Seed URLs from every sitemap in `sitemapUrls` (resolve which ones those are
 * with `resolveSitemapUrls` first — this function no longer guesses). Only
 * page URLs within `allowedOrigins` are returned. Absence, errors, and
 * malformed XML on any individual sitemap yield no entries from that sitemap
 * — a sitemap is a seed source, never a failure.
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
    const { pageUrls } = await walkSitemap(fetchFn, sitemapUrl, allowedOrigins, limit);
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
