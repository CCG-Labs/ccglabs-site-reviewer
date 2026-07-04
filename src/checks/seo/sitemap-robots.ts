import { allowedOriginsFor } from "../../crawl/crawler.js";
import { parseSitemapXml } from "../../crawl/sitemap.js";
import { normalizePageUrl } from "../../crawl/url.js";
import type { Check, Finding, RateLimitedFetch } from "../../types.js";
import { headerNoindex } from "./meta-tags.js";
import { extractPageMeta } from "./page-meta.js";
import { isDisallowed, parseRobotsTxt, type RobotsTxt } from "./robots.js";

const MAX_CHILD_SITEMAPS = 10;
const MAX_SITEMAP_ENTRIES = 2000;
const MISSING_FROM_SITEMAP_LIMIT = 20;
const ERROR_COST = 20;
const WARNING_COST = 5;

interface SitemapFetchResult {
  exists: boolean;
  entries: string[];
  emptyButPresent: boolean;
  failure: string | undefined;
}

async function fetchSitemapEntries(
  fetchFn: RateLimitedFetch,
  origin: string,
  allowed: ReadonlySet<string>,
): Promise<SitemapFetchResult> {
  const sitemapUrl = new URL("/sitemap.xml", origin).href;
  try {
    const response = await fetchFn(sitemapUrl);
    if (response.status !== 200) {
      return {
        exists: false,
        entries: [],
        emptyButPresent: false,
        failure: `HTTP ${String(response.status)}`,
      };
    }
    const root = parseSitemapXml(response.body);
    const entries = [...root.pageUrls];
    for (const child of root.childSitemaps.slice(0, MAX_CHILD_SITEMAPS)) {
      if (entries.length >= MAX_SITEMAP_ENTRIES) break;
      // never send requests (which carry configured auth headers) to foreign origins
      const childUrl = normalizePageUrl(child);
      if (childUrl === undefined || !allowed.has(new URL(childUrl).origin)) continue;
      try {
        const childResponse = await fetchFn(childUrl);
        if (childResponse.status === 200)
          entries.push(...parseSitemapXml(childResponse.body).pageUrls);
      } catch {
        // unreachable child sitemaps are covered by the entry-level checks
      }
    }
    return {
      exists: true,
      entries: entries.slice(0, MAX_SITEMAP_ENTRIES),
      emptyButPresent: entries.length === 0 && root.childSitemaps.length === 0,
      failure: undefined,
    };
  } catch (error) {
    return {
      exists: false,
      entries: [],
      emptyButPresent: false,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

export const sitemapRobotsCheck: Check = {
  id: "seo.sitemap-robots",
  category: "seo",
  description:
    "sitemap.xml exists and lists only live, canonical, indexable URLs; robots.txt is sane and references the sitemap.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const origin = new URL(ctx.baseUrl).origin;
    const sitemapUrl = new URL("/sitemap.xml", origin).href;
    const robotsUrl = new URL("/robots.txt", origin).href;
    const findings: Finding[] = [];
    const add = (
      severity: Finding["severity"],
      url: string,
      message: string,
      recommendation: string,
    ): void => {
      findings.push({ severity, url, message, recommendation });
    };

    let robots: RobotsTxt | undefined;
    try {
      const response = await ctx.fetch(robotsUrl);
      if (response.status === 200) robots = parseRobotsTxt(response.body);
      else
        add(
          "warning",
          robotsUrl,
          `robots.txt is missing (HTTP ${String(response.status)}).`,
          "Add a robots.txt that allows crawling and references your sitemap.",
        );
    } catch {
      add(
        "warning",
        robotsUrl,
        "robots.txt could not be fetched.",
        "Ensure /robots.txt is served.",
      );
    }

    if (robots !== undefined && isDisallowed(ctx.baseUrl, robots)) {
      add(
        ctx.environment === "production" ? "error" : "warning",
        robotsUrl,
        "robots.txt blocks the site root for all crawlers (Disallow matches the base URL).",
        "Remove the blanket Disallow before launch — search engines cannot index the site.",
      );
    }

    const allowed = allowedOriginsFor(new URL(ctx.baseUrl));
    const sitemap = await fetchSitemapEntries(ctx.fetch, origin, allowed);
    if (!sitemap.exists) {
      add(
        "warning",
        sitemapUrl,
        `sitemap.xml is missing (${sitemap.failure ?? "unknown"}).`,
        "Generate and serve a sitemap so search engines can discover every page.",
      );
    } else if (sitemap.emptyButPresent) {
      add(
        "error",
        sitemapUrl,
        "sitemap.xml contains no URLs (empty or unparseable XML).",
        "Fix the sitemap generator — an empty sitemap hides the whole site from crawlers.",
      );
    }

    if (robots !== undefined && sitemap.exists && robots.sitemaps.length === 0) {
      add(
        "warning",
        robotsUrl,
        "robots.txt does not reference the sitemap.",
        `Add "Sitemap: ${sitemapUrl}" to robots.txt.`,
      );
    }

    const capped = ctx.pages.stats().capped;
    const entrySet = new Set<string>();
    let skippedUnverifiable = 0;

    for (const raw of sitemap.entries) {
      const entry = normalizePageUrl(raw);
      if (entry === undefined) {
        add(
          "error",
          sitemapUrl,
          `Sitemap contains an invalid URL: ${raw}`,
          "Remove or fix the malformed entry.",
        );
        continue;
      }
      entrySet.add(entry);
      if (!allowed.has(new URL(entry).origin)) {
        add(
          "warning",
          entry,
          `Sitemap lists a cross-origin URL: ${entry}`,
          "A sitemap should only list URLs on its own host.",
        );
        continue;
      }
      const page = ctx.pages.get(entry);
      if (page === undefined) {
        if (capped) {
          skippedUnverifiable += 1;
          continue;
        }
        add(
          "error",
          entry,
          `Sitemap lists ${entry}, which could not be fetched during the crawl.`,
          "Remove dead URLs from the sitemap or restore the pages.",
        );
        continue;
      }
      if (page.status >= 400) {
        add(
          "error",
          entry,
          `Sitemap lists ${entry}, which returns HTTP ${String(page.status)}.`,
          "Sitemaps must only list live (200) pages — remove or fix this entry.",
        );
        continue;
      }
      if (page.redirected || page.finalUrl !== page.url) {
        add(
          "warning",
          entry,
          `Sitemap lists ${entry}, which redirects to ${page.finalUrl}.`,
          "List the final canonical URL directly instead of a redirecting one.",
        );
      } else {
        // Header-based noindex (e.g. X-Robots-Tag on a PDF) can apply to any
        // stored entry, HTML or not; only the meta-tag/canonical checks need a body.
        const meta = page.body !== "" ? extractPageMeta(page.body) : undefined;
        if ((meta?.metaNoindex ?? false) || headerNoindex(page)) {
          add(
            "error",
            entry,
            `Sitemap lists ${entry}, which is marked noindex.`,
            "Remove noindexed pages from the sitemap — the two signals contradict each other.",
          );
        } else if (meta !== undefined && meta.canonicals.length === 1) {
          const canonical = normalizePageUrl(meta.canonicals[0] ?? "", page.finalUrl);
          if (canonical !== undefined && canonical !== entry && canonical !== page.finalUrl) {
            add(
              "warning",
              entry,
              `Sitemap lists ${entry}, whose canonical points at ${canonical}.`,
              "List the canonical URL in the sitemap instead.",
            );
          }
        }
      }
      if (robots !== undefined && isDisallowed(entry, robots)) {
        add(
          "error",
          entry,
          `Sitemap lists ${entry}, which robots.txt disallows.`,
          "Remove the entry from the sitemap or the Disallow rule from robots.txt.",
        );
      }
    }

    const missingBlockStart = findings.length;
    if (sitemap.exists && entrySet.size > 0) {
      let missing = 0;
      for (const page of ctx.pages.htmlPages()) {
        if (page.status < 200 || page.status >= 300) continue;
        if (page.redirected || page.finalUrl !== page.url) continue;
        const meta = extractPageMeta(page.body);
        if (meta.metaNoindex || headerNoindex(page)) continue;
        const finalKey = normalizePageUrl(page.finalUrl) ?? page.finalUrl;
        if (entrySet.has(page.url) || entrySet.has(finalKey)) continue;
        missing += 1;
        if (missing <= MISSING_FROM_SITEMAP_LIMIT) {
          add(
            "warning",
            page.url,
            `Indexable page is missing from the sitemap: ${page.url}`,
            "Add the page to the sitemap (or noindex it if it should not be indexed).",
          );
        }
      }
      if (missing > MISSING_FROM_SITEMAP_LIMIT) {
        add(
          "warning",
          sitemapUrl,
          `${String(missing - MISSING_FROM_SITEMAP_LIMIT)} more indexable pages are missing from the sitemap.`,
          "Regenerate the sitemap from the full page inventory.",
        );
      }
    }

    if (skippedUnverifiable > 0) {
      ctx.logger.debug("Sitemap entries skipped as unverifiable (crawl capped)", {
        count: skippedUnverifiable,
      });
    }
    ctx.logger.debug("Sitemap/robots summary", {
      entries: sitemap.entries.length,
      findings: findings.length,
    });

    // Missing-from-sitemap findings emitted in the block above (up to
    // MISSING_FROM_SITEMAP_LIMIT individual warnings plus one summary warning).
    const missingWarningFindingsEmitted = findings.length - missingBlockStart;

    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    // A site missing dozens of pages from its sitemap is one soft condition,
    // not dozens of independent problems — cap that class's scoring
    // contribution at 4 warning-units (20 points) so it can't alone saturate
    // the score to 0 while the full findings list still reports every page.
    const otherWarnings = warnings - missingWarningFindingsEmitted;
    const scoringWarnings = otherWarnings + Math.min(missingWarningFindingsEmitted, 4);
    return {
      score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * scoringWarnings),
      findings,
    };
  },
};
