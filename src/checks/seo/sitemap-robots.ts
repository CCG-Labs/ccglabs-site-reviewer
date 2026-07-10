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
import { BodySizeCapError } from "../../fetch/fetcher.js";
import type { Check, Finding, RateLimitedFetch } from "../../types.js";
import { headerNoindex } from "./meta-tags.js";
import { extractPageMeta } from "./page-meta.js";

const MAX_CHILD_SITEMAPS = 10;
const MAX_SITEMAP_ENTRIES = 2000;
const MISSING_FROM_SITEMAP_LIMIT = 20;
const ERROR_COST = 20;
const WARNING_COST = 5;

// sitemaps.org's per-file URL-count cap (see the protocol spec). There's a matching 50MB
// byte cap in the spec too, but this tool's shared fetcher already refuses any response body
// over 5MB (see fetch/fetcher.ts) — well under 50MB — so a sitemap that large never reaches
// this code at all; it surfaces via the BodySizeCapError handling below instead of a
// dedicated spec-limit check that could never fire.
const SITEMAP_SPEC_URL_LIMIT = 50_000;

interface SitemapFetchResult {
  exists: boolean;
  entries: string[];
  emptyButPresent: boolean;
  failure: string | undefined;
  /** child sitemaps actually visited (bounded by MAX_CHILD_SITEMAPS and cut short if the
   *  MAX_SITEMAP_ENTRIES cap is hit) — not the raw declared count. 0 for a plain urlset. */
  totalChildSitemaps: number;
  /** of totalChildSitemaps, how many were skipped without being fetched (different origin / invalid URL) */
  crossOriginChildSitemaps: number;
  /** of the *attempted* (same-origin) children, how many failed to fetch */
  failedChildSitemaps: number;
  /** declared children never visited at all because MAX_SITEMAP_ENTRIES was hit first —
   *  these are neither known-good nor known-bad, just unchecked */
  uncheckedChildSitemaps: number;
  /** this file, or any of its child sitemaps, declares more than 50,000 entries */
  oversizedEntries: boolean;
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
        crossOriginChildSitemaps: 0,
        failedChildSitemaps: 0,
        uncheckedChildSitemaps: 0,
        oversizedEntries: false,
      };
    }
    const root = parseSitemapXml(response.body);
    let oversizedEntries =
      root.pageUrls.length > SITEMAP_SPEC_URL_LIMIT ||
      root.childSitemaps.length > SITEMAP_SPEC_URL_LIMIT;

    const entries = [...root.pageUrls];
    const childSitemaps = root.childSitemaps.slice(0, MAX_CHILD_SITEMAPS);
    // Fire every child fetch off immediately — concurrently, not one-at-a-time — so a
    // slow/hanging child's timeout doesn't stack on top of every other child's (sequential
    // fetching of up to MAX_CHILD_SITEMAPS children could previously cost minutes against a
    // struggling target). Results are still *evaluated* in declaration order below so the
    // MAX_SITEMAP_ENTRIES early-exit semantics (and uncheckedChildSitemaps bookkeeping) are
    // unchanged — by the time we await a later child's promise it's usually already settled,
    // since all of them started running before this loop began.
    const childFetches = childSitemaps.map(
      async (
        child,
      ): Promise<
        | { kind: "cross-origin" }
        | { kind: "failed" }
        | { kind: "ok"; parsed: ReturnType<typeof parseSitemapXml> }
      > => {
        // never send requests (which carry configured auth headers) to foreign origins —
        // a cross-origin child is simply never checked, which is not the same problem as
        // a same-origin child that was attempted and failed (see run()'s use of this field).
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

    // Count only children the loop actually visits — not childSitemaps.length. If the
    // MAX_SITEMAP_ENTRIES cap is hit partway through, the remaining declared children are
    // never looked at, and must not be silently folded into "reachable" (that's exactly the
    // silent-pass bug this branch exists to fix: a large valid child before broken ones
    // would otherwise mask the broken ones by inflating the apparent "total").
    let visitedChildSitemaps = 0;
    let crossOriginChildSitemaps = 0;
    let failedChildSitemaps = 0;
    for (const childFetch of childFetches) {
      if (entries.length >= MAX_SITEMAP_ENTRIES) break;
      visitedChildSitemaps += 1;
      const result = await childFetch;
      if (result.kind === "cross-origin") {
        crossOriginChildSitemaps += 1;
      } else if (result.kind === "failed") {
        failedChildSitemaps += 1;
      } else {
        entries.push(...result.parsed.pageUrls);
        if (result.parsed.pageUrls.length > SITEMAP_SPEC_URL_LIMIT) oversizedEntries = true;
      }
    }
    return {
      exists: true,
      entries: entries.slice(0, MAX_SITEMAP_ENTRIES),
      emptyButPresent: entries.length === 0 && childSitemaps.length === 0,
      failure: undefined,
      totalChildSitemaps: visitedChildSitemaps,
      crossOriginChildSitemaps,
      failedChildSitemaps,
      uncheckedChildSitemaps: childSitemaps.length - visitedChildSitemaps,
      oversizedEntries,
    };
  } catch (error) {
    return {
      exists: false,
      entries: [],
      emptyButPresent: false,
      // BodySizeCapError means the shared fetcher's 5MB cap was hit (see the comment on
      // SITEMAP_SPEC_URL_LIMIT above) — give an actionable message instead of a generic one.
      failure:
        error instanceof BodySizeCapError
          ? `too large to fetch — exceeds this tool's response size cap (${error.message})`
          : error instanceof Error
            ? error.message
            : String(error),
      totalChildSitemaps: 0,
      crossOriginChildSitemaps: 0,
      failedChildSitemaps: 0,
      uncheckedChildSitemaps: 0,
      oversizedEntries: false,
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
      // Cross-origin children are a different problem than failed ones: a sitemap index
      // that legitimately spans subdomains (blog.example.com, shop.example.com — a real,
      // non-broken pattern) is never "attempted" here at all, so it must not be scored
      // the same as an index whose children genuinely 404 or error out.
      const attemptedChildSitemaps = result.totalChildSitemaps - result.crossOriginChildSitemaps;
      if (attemptedChildSitemaps > 0 && result.failedChildSitemaps === attemptedChildSitemaps) {
        add(
          "error",
          url,
          `Sitemap index at ${url} references ${String(attemptedChildSitemaps)} child sitemap(s) on its own origin, but none could be fetched.`,
          "Fix or remove the dead child sitemap references — an index pointing at nothing is as bad as no sitemap.",
        );
      } else if (result.failedChildSitemaps > 0) {
        add(
          "warning",
          url,
          `Sitemap index at ${url} references ${String(attemptedChildSitemaps)} child sitemap(s) on its own origin; ${String(result.failedChildSitemaps)} could not be fetched.`,
          "Fix or remove the dead child sitemap references.",
        );
      }
      if (result.crossOriginChildSitemaps > 0) {
        add(
          "warning",
          url,
          `Sitemap index at ${url} references ${String(result.crossOriginChildSitemaps)} child sitemap(s) on a different origin — these are never fetched.`,
          "A sitemap should only reference child sitemaps on its own host, or the operator should confirm this cross-origin reference is intentional.",
        );
      }
      if (result.uncheckedChildSitemaps > 0) {
        add(
          "warning",
          url,
          `Sitemap index at ${url} has ${String(result.uncheckedChildSitemaps)} more child sitemap(s) that weren't checked because the ${String(MAX_SITEMAP_ENTRIES)}-URL processing cap was reached first.`,
          "Split this sitemap into smaller files, or raise MAX_SITEMAP_ENTRIES if you need full coverage of very large sites.",
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
