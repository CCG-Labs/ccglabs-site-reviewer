import { allowedOriginsFor } from "../../crawl/crawler.js";
import { pageDom } from "../../crawl/page-dom.js";
import {
  isDisallowed,
  parseRobotsTxt,
  resolveSitemapUrls,
  type RobotsTxt,
} from "../../crawl/robots.js";
import { parseSitemapXml } from "../../crawl/sitemap.js";
import { normalizePageUrl } from "../../crawl/url.js";
import type { Check, Finding, RateLimitedFetch } from "../../types.js";
import { headerNoindex } from "./meta-tags.js";
import { extractPageMeta } from "./page-meta.js";

const MAX_CHILD_SITEMAPS = 10;
const MAX_SITEMAP_ENTRIES = 2000;
const MISSING_FROM_SITEMAP_LIMIT = 20;
const ERROR_COST = 20;
const WARNING_COST = 5;

// sitemaps.org hard caps, per file (index or urlset) — see the protocol spec.
const SITEMAP_SPEC_URL_LIMIT = 50_000;
const SITEMAP_SPEC_BYTE_LIMIT = 50 * 1024 * 1024;

interface SitemapFetchResult {
  exists: boolean;
  entries: string[];
  emptyButPresent: boolean;
  failure: string | undefined;
  /** child sitemaps actually attempted (bounded by MAX_CHILD_SITEMAPS), 0 for a plain urlset */
  totalChildSitemaps: number;
  /** of totalChildSitemaps, how many could not be fetched (incl. cross-origin/invalid) */
  unreachableChildSitemaps: number;
  /** this file, or any of its child sitemaps, declares more than 50,000 entries */
  oversizedEntries: boolean;
  /** this file, or any of its child sitemaps, is over 50MB uncompressed */
  oversizedBytes: boolean;
}

async function fetchSitemapEntries(
  fetchFn: RateLimitedFetch,
  sitemapUrl: string,
  allowed: ReadonlySet<string>,
): Promise<SitemapFetchResult> {
  try {
    const response = await fetchFn(sitemapUrl);
    if (response.status !== 200) {
      return {
        exists: false,
        entries: [],
        emptyButPresent: false,
        failure: `HTTP ${String(response.status)}`,
        totalChildSitemaps: 0,
        unreachableChildSitemaps: 0,
        oversizedEntries: false,
        oversizedBytes: false,
      };
    }
    const root = parseSitemapXml(response.body);
    let oversizedEntries =
      root.pageUrls.length > SITEMAP_SPEC_URL_LIMIT ||
      root.childSitemaps.length > SITEMAP_SPEC_URL_LIMIT;
    let oversizedBytes = Buffer.byteLength(response.body, "utf8") > SITEMAP_SPEC_BYTE_LIMIT;

    const entries = [...root.pageUrls];
    const childSitemaps = root.childSitemaps.slice(0, MAX_CHILD_SITEMAPS);
    let unreachableChildSitemaps = 0;
    for (const child of childSitemaps) {
      if (entries.length >= MAX_SITEMAP_ENTRIES) break;
      // never send requests (which carry configured auth headers) to foreign origins
      const childUrl = normalizePageUrl(child);
      if (childUrl === undefined || !allowed.has(new URL(childUrl).origin)) {
        unreachableChildSitemaps += 1;
        continue;
      }
      try {
        const childResponse = await fetchFn(childUrl);
        if (childResponse.status === 200) {
          const childParsed = parseSitemapXml(childResponse.body);
          entries.push(...childParsed.pageUrls);
          if (childParsed.pageUrls.length > SITEMAP_SPEC_URL_LIMIT) oversizedEntries = true;
          if (Buffer.byteLength(childResponse.body, "utf8") > SITEMAP_SPEC_BYTE_LIMIT)
            oversizedBytes = true;
        } else {
          unreachableChildSitemaps += 1;
        }
      } catch {
        unreachableChildSitemaps += 1;
      }
    }
    return {
      exists: true,
      entries: entries.slice(0, MAX_SITEMAP_ENTRIES),
      emptyButPresent: entries.length === 0 && childSitemaps.length === 0,
      failure: undefined,
      totalChildSitemaps: childSitemaps.length,
      unreachableChildSitemaps,
      oversizedEntries,
      oversizedBytes,
    };
  } catch (error) {
    return {
      exists: false,
      entries: [],
      emptyButPresent: false,
      failure: error instanceof Error ? error.message : String(error),
      totalChildSitemaps: 0,
      unreachableChildSitemaps: 0,
      oversizedEntries: false,
      oversizedBytes: false,
    };
  }
}

export const sitemapRobotsCheck: Check = {
  id: "seo.sitemap-robots",
  category: "seo",
  description:
    "Every sitemap this site declares (via robots.txt, or the conventional /sitemap.xml when none is declared) exists, parses, and lists only live, canonical, indexable URLs; robots.txt is sane and references the sitemap.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const origin = new URL(ctx.baseUrl).origin;
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
    const {
      urls: sitemapUrls,
      source,
      truncated,
    } = resolveSitemapUrls(robots, origin, robotsUrl, allowed);
    if (truncated) {
      add(
        "warning",
        robotsUrl,
        `robots.txt declares more than ${String(sitemapUrls.length)} sitemaps; only the first ${String(sitemapUrls.length)} were checked.`,
        "Consolidate into a sitemap index instead of dozens of individual Sitemap: lines.",
      );
    }
    const results = await Promise.all(
      sitemapUrls.map((url) => fetchSitemapEntries(ctx.fetch, url, allowed)),
    );

    let anyExists = false;
    const entrySet = new Set<string>();
    const validatedEntries = new Set<string>();
    const capped = ctx.pages.stats().capped;
    let skippedUnverifiable = 0;

    for (let i = 0; i < sitemapUrls.length; i += 1) {
      const url = sitemapUrls[i] ?? "";
      const result = results[i];
      if (result === undefined) continue;

      if (!result.exists) {
        add(
          "warning",
          url,
          source === "robots"
            ? `Sitemap declared in robots.txt could not be fetched: ${url} (${result.failure ?? "unknown"}).`
            : `sitemap.xml is missing (${result.failure ?? "unknown"}).`,
          "Generate and serve a sitemap so search engines can discover every page.",
        );
        continue;
      }
      anyExists = true;

      if (result.emptyButPresent) {
        add(
          "error",
          url,
          `Sitemap at ${url} contains no URLs (empty or unparseable XML).`,
          "Fix the sitemap generator — an empty sitemap hides pages from crawlers.",
        );
      }
      if (
        result.totalChildSitemaps > 0 &&
        result.unreachableChildSitemaps === result.totalChildSitemaps
      ) {
        add(
          "error",
          url,
          `Sitemap index at ${url} references ${String(result.totalChildSitemaps)} child sitemap(s), but none could be fetched.`,
          "Fix or remove the dead child sitemap references — an index pointing at nothing is as bad as no sitemap.",
        );
      } else if (result.unreachableChildSitemaps > 0) {
        add(
          "warning",
          url,
          `Sitemap index at ${url} references ${String(result.totalChildSitemaps)} child sitemap(s); ${String(result.unreachableChildSitemaps)} could not be fetched.`,
          "Fix or remove the dead child sitemap references.",
        );
      }
      if (result.oversizedEntries) {
        add(
          "warning",
          url,
          `Sitemap at ${url} has more than 50,000 URLs — at or over the sitemaps.org per-file limit.`,
          "Split into multiple sitemaps referenced from a sitemap index.",
        );
      }
      if (result.oversizedBytes) {
        add(
          "warning",
          url,
          `Sitemap at ${url} is at or over the sitemaps.org 50MB-per-file limit.`,
          "Split into multiple smaller sitemaps referenced from a sitemap index, or gzip it (the spec allows .xml.gz).",
        );
      }

      for (const raw of result.entries) {
        const entry = normalizePageUrl(raw);
        if (entry === undefined) {
          add(
            "error",
            url,
            `Sitemap at ${url} contains an invalid URL: ${raw}`,
            "Remove or fix the malformed entry.",
          );
          continue;
        }
        entrySet.add(entry);
        // A URL can legitimately appear in more than one declared sitemap; validate it once.
        if (validatedEntries.has(entry)) continue;
        validatedEntries.add(entry);

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
          const meta = page.body !== "" ? extractPageMeta(pageDom(page)) : undefined;
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
    }

    if (robots !== undefined && anyExists && robots.sitemaps.length === 0) {
      add(
        "warning",
        robotsUrl,
        "robots.txt does not reference the sitemap.",
        `Add "Sitemap: ${sitemapUrls[0] ?? ""}" to robots.txt.`,
      );
    }

    const missingBlockStart = findings.length;
    if (anyExists && entrySet.size > 0) {
      let missing = 0;
      for (const page of ctx.pages.htmlPages()) {
        if (page.status < 200 || page.status >= 300) continue;
        if (page.redirected || page.finalUrl !== page.url) continue;
        const meta = extractPageMeta(pageDom(page));
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
          sitemapUrls[0] ?? robotsUrl,
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
      sitemaps: sitemapUrls.length,
      entries: entrySet.size,
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
