import { allowedOriginsFor } from "../../crawl/crawler.js";
import type { Check, CheckContext, Finding } from "../../types.js";
import { extractPageRefs, hasAnchorTarget } from "./link-extract.js";

const EXTERNAL_PROBE_LIMIT = 50;

interface LinkCheckOptions {
  ignore: string[];
}

function linkOptions(ctx: CheckContext): LinkCheckOptions {
  const raw = ctx.config.checks["functionality.links"]?.options?.["ignore"];
  return {
    ignore: Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

type ProbeResult = { kind: "status"; status: number } | { kind: "unreachable"; message: string };

export const linksCheck: Check = {
  id: "functionality.links",
  category: "functionality",
  description:
    "Internal links, anchors, and assets resolve; external links are validated in production (non-blocking).",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    ctx.logger.debug("Checking links", { pagesChecked: pages.length });
    if (pages.length === 0) return { score: 100, findings: [] };

    const options = linkOptions(ctx);
    const isIgnored = (url: string): boolean =>
      options.ignore.some((pattern) => url.includes(pattern));
    const allowedOrigins = allowedOriginsFor(new URL(ctx.baseUrl));
    const capped = ctx.pages.stats().capped;

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    const probeCache = new Map<string, Promise<ProbeResult>>();
    const probe = (url: string): Promise<ProbeResult> => {
      const cached = probeCache.get(url);
      if (cached !== undefined) return cached;
      const result = (async (): Promise<ProbeResult> => {
        try {
          const head = await ctx.fetch(url, { method: "HEAD" });
          if (head.status === 405 || head.status === 501) {
            const get = await ctx.fetch(url);
            return { kind: "status", status: get.status };
          }
          return { kind: "status", status: head.status };
        } catch (error) {
          return {
            kind: "unreachable",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })();
      probeCache.set(url, result);
      return result;
    };

    /** external URL (or internal asset) → first page that referenced it */
    const internalAssetRefs = new Map<string, string>();
    const externalRefs = new Map<string, string>();
    let unverifiable = 0;

    for (const page of pages) {
      const refs = extractPageRefs(page.body, page.finalUrl);

      for (const link of refs.links) {
        if (isIgnored(link.url)) continue;
        if (allowedOrigins.has(new URL(link.url).origin)) {
          const target = ctx.pages.get(link.url);
          if (target === undefined) {
            if (capped) {
              unverifiable += 1;
              continue;
            }
            record({
              severity: "error",
              url: page.url,
              message: `Broken internal link: ${link.url} could not be fetched.`,
              recommendation: "Fix or remove the link; the target did not respond when crawled.",
            });
          } else if (target.status >= 400) {
            record({
              severity: "error",
              url: page.url,
              message: `Broken internal link: ${link.url} returns HTTP ${String(target.status)}.`,
              recommendation: "Fix or remove the link, or restore the target page.",
            });
          } else if (
            link.fragment !== undefined &&
            target.body !== "" &&
            !hasAnchorTarget(target.body, link.fragment)
          ) {
            record({
              severity: "warning",
              url: page.url,
              message: `Anchor #${link.fragment} not found on ${link.url}.`,
              recommendation: "Point the fragment at an existing element id, or remove it.",
            });
          }
        } else if (ctx.environment === "production" && !externalRefs.has(link.url)) {
          externalRefs.set(link.url, page.url);
        }
      }

      for (const asset of refs.assets) {
        if (isIgnored(asset)) continue;
        if (allowedOrigins.has(new URL(asset).origin)) {
          if (!internalAssetRefs.has(asset)) internalAssetRefs.set(asset, page.url);
        } else if (ctx.environment === "production" && !externalRefs.has(asset)) {
          externalRefs.set(asset, page.url);
        }
      }
    }

    await Promise.all(
      [...internalAssetRefs.entries()].map(async ([assetUrl, pageUrl]) => {
        const result = await probe(assetUrl);
        if (result.kind === "unreachable") {
          record({
            severity: "error",
            url: pageUrl,
            message: `Asset unreachable: ${assetUrl} (${result.message}).`,
            recommendation: "Fix the asset path or restore the file.",
          });
        } else if (result.status >= 400) {
          record({
            severity: "error",
            url: pageUrl,
            message: `Broken asset: ${assetUrl} returns HTTP ${String(result.status)}.`,
            recommendation: "Fix the asset path or restore the file.",
          });
        }
      }),
    );

    const externalEntries = [...externalRefs.entries()];
    if (externalEntries.length > EXTERNAL_PROBE_LIMIT) {
      ctx.logger.debug("External probe cap reached", {
        probed: EXTERNAL_PROBE_LIMIT,
        skipped: externalEntries.length - EXTERNAL_PROBE_LIMIT,
      });
      externalEntries.length = EXTERNAL_PROBE_LIMIT;
    }
    await Promise.all(
      externalEntries.map(async ([url, pageUrl]) => {
        const result = await probe(url);
        if (result.kind === "unreachable") {
          record({
            severity: "warning",
            url: pageUrl,
            message: `External link unreachable: ${url} (${result.message}).`,
            recommendation: "Verify the destination still exists; update or remove the link.",
          });
        } else if (result.status === 403 || result.status === 429) {
          ctx.logger.debug("External target refused the automated request", {
            url,
            status: result.status,
          });
        } else if (result.status >= 400) {
          record({
            severity: "warning",
            url: pageUrl,
            message: `Broken external link: ${url} returns HTTP ${String(result.status)}.`,
            recommendation: "Update or remove the link.",
          });
        }
      }),
    );

    if (unverifiable > 0) {
      ctx.logger.debug("Internal links skipped as unverifiable (crawl capped)", {
        count: unverifiable,
      });
    }

    const cleanPages = pages.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / pages.length), findings };
  },
};
