import { samplePages } from "../../browser/sample.js";
import type { Check, CheckContext, Finding } from "../../types.js";

/** Post-load wait for async analytics beacons. */
const DEFAULT_SETTLE_MS = 2000;
const MAX_SETTLE_MS = 10_000;

type ProviderId = "ga4" | "plausible" | "fathom";

interface ProviderSpec {
  label: string;
  /** hostname suffixes owned by this provider */
  hosts: string[];
  /** a tracking hit (an event actually sent), as opposed to the script loader */
  isHit(url: URL, method: string): boolean;
  /** the loader script request — proves the snippet is installed even when nothing fires */
  isLoader(url: URL): boolean;
  /** counts toward double-fire detection */
  isPageview(url: URL, method: string): boolean;
  /** property/site ID carried in the request URL, when extractable */
  propertyId(url: URL): string | null;
}

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  ga4: {
    label: "GA4",
    hosts: ["google-analytics.com", "googletagmanager.com"],
    isHit: (url) => url.pathname.includes("/collect"),
    isLoader: (url) =>
      hostMatches(url.hostname, "googletagmanager.com") && url.pathname.startsWith("/gtag/js"),
    isPageview: (url) =>
      url.pathname.includes("/collect") && url.searchParams.get("en") === "page_view",
    propertyId: (url) => url.searchParams.get("tid") ?? url.searchParams.get("id"),
  },
  plausible: {
    label: "Plausible",
    hosts: ["plausible.io"],
    isHit: (url, method) => url.pathname === "/api/event" && method === "POST",
    isLoader: (url) => url.pathname.startsWith("/js/"),
    // Plausible sends the event name in the POST body (unavailable at this seam);
    // treat every event during initial load as a pageview — a plain load fires exactly one.
    isPageview: (url, method) => url.pathname === "/api/event" && method === "POST",
    propertyId: () => null,
  },
  fathom: {
    label: "Fathom",
    hosts: ["usefathom.com"],
    isHit: (url) => url.searchParams.has("sid"),
    isLoader: (url) => url.pathname.endsWith("/script.js"),
    isPageview: (url) => url.searchParams.has("sid"),
    propertyId: (url) => url.searchParams.get("sid"),
  },
};

interface AnalyticsOptions {
  provider?: ProviderId;
  propertyId?: string;
  /** extra hostname suffixes (self-hosted Plausible, Matomo, Umami, …) counted as hits */
  hosts: string[];
  settleMs: number;
}

function analyticsOptions(ctx: CheckContext): AnalyticsOptions {
  const raw = ctx.config.checks["operations.analytics"]?.options;
  const provider = raw?.["provider"];
  const propertyId = raw?.["propertyId"];
  const settle = raw?.["settleMs"];
  return {
    provider:
      provider === "ga4" || provider === "plausible" || provider === "fathom"
        ? provider
        : undefined,
    propertyId: typeof propertyId === "string" && propertyId !== "" ? propertyId : undefined,
    hosts: Array.isArray(raw?.["hosts"])
      ? raw["hosts"].filter((entry): entry is string => typeof entry === "string")
      : [],
    settleMs:
      typeof settle === "number" && Number.isFinite(settle)
        ? Math.min(MAX_SETTLE_MS, Math.max(0, Math.round(settle)))
        : DEFAULT_SETTLE_MS,
  };
}

interface PageObservation {
  hits: number;
  pageviews: number;
  loaderSeen: boolean;
  observedIds: Set<string>;
}

function observe(
  requests: Array<{ url: string; method: string }>,
  options: AnalyticsOptions,
): PageObservation {
  const specs =
    options.provider === undefined ? Object.values(PROVIDERS) : [PROVIDERS[options.provider]];
  const result: PageObservation = {
    hits: 0,
    pageviews: 0,
    loaderSeen: false,
    observedIds: new Set(),
  };
  for (const request of requests) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }
    if (options.hosts.some((suffix) => hostMatches(url.hostname, suffix))) {
      // Custom hosts count as hits only — we can't tell loaders from beacons, so they're exempt from double-fire detection.
      result.hits += 1;
      continue;
    }
    for (const spec of specs) {
      if (!spec.hosts.some((suffix) => hostMatches(url.hostname, suffix))) continue;
      if (spec.isLoader(url)) result.loaderSeen = true;
      if (spec.isHit(url, request.method)) {
        result.hits += 1;
        if (spec.isPageview(url, request.method)) result.pageviews += 1;
        const id = spec.propertyId(url);
        if (id !== null) result.observedIds.add(id);
      }
      break;
    }
  }
  return result;
}

export const analyticsCheck: Check = {
  id: "operations.analytics",
  category: "operations",
  description:
    "Verifies analytics actually fires (GA4/Plausible/Fathom auto-detected, or configured) with the expected property ID and no double-firing.",
  environments: ["production"],
  requires: "browser",
  blocking: false,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const targets = samplePages(ctx.pages.all(), ctx.baseUrl, 1);
    if (targets.length === 0) return { score: 100, findings: [] };

    const options = analyticsOptions(ctx);
    const findings: Finding[] = [];
    const dirtyPages = new Set<string>();

    for (const target of targets) {
      const page = await browser.newPage();
      try {
        const requests: Array<{ url: string; method: string }> = [];
        page.onRequest((url, method) => requests.push({ url, method }));
        try {
          await page.goto(target.url);
        } catch (error) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: `Page could not be loaded for the analytics check: ${error instanceof Error ? error.message : String(error)}`,
            recommendation:
              "Re-run; if this persists the page may hang or block automated browsers.",
          });
          continue;
        }
        if (options.settleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.settleMs));
        }

        const seen = observe(requests, options);

        if (seen.hits === 0) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: seen.loaderSeen
              ? `The analytics tag script loaded on ${target.url}, but no events fired (waited ${String(options.settleMs)} ms) — a consent manager or blocker may be suppressing it.`
              : `No analytics hits observed on ${target.url} (waited ${String(options.settleMs)} ms after load).`,
            recommendation:
              "Install or fix the analytics snippet; if this site intentionally has no analytics, disable this check in the config.",
          });
          dirtyPages.add(target.url);
        }

        if (
          options.propertyId !== undefined &&
          seen.observedIds.size > 0 &&
          ![...seen.observedIds].some(
            (id) => id.toLowerCase() === options.propertyId?.toLowerCase(),
          )
        ) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: `Analytics fired with property ID ${[...seen.observedIds].join(", ")} on ${target.url}, expected ${options.propertyId}.`,
            recommendation:
              "A staging/wrong property ID pollutes production data — point the snippet at the expected property.",
          });
          dirtyPages.add(target.url);
        }

        if (seen.pageviews > 1) {
          findings.push({
            severity: "warning",
            url: target.url,
            message: `${String(seen.pageviews)} pageview hits fired on a single load of ${target.url} — the analytics tag may be installed twice.`,
            recommendation:
              "Double-counting inflates traffic metrics; ensure the snippet is included exactly once.",
          });
          dirtyPages.add(target.url);
        }

        ctx.logger.debug("Analytics observation", {
          url: target.url,
          requests: requests.length,
          hits: seen.hits,
          pageviews: seen.pageviews,
          loaderSeen: seen.loaderSeen,
          observedIds: [...seen.observedIds],
        });
      } finally {
        await page.close();
      }
    }

    const cleanPages = targets.length - dirtyPages.size;
    return { score: Math.round((100 * cleanPages) / targets.length), findings };
  },
};
