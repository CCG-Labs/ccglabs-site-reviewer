import { allowedOriginsFor } from "../../crawl/crawler.js";
import { pageDom } from "../../crawl/page-dom.js";
import { normalizePageUrl } from "../../crawl/url.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const DEFAULT_MAX_IMAGE_BYTES = 500_000;
const INTERNAL_PROBE_LIMIT = 500;
const EXTERNAL_PROBE_LIMIT = 50;
const SAMPLE = 3;

interface ImageOptions {
  maxImageBytes: number;
  ignore: string[];
}

function imageOptions(ctx: CheckContext): ImageOptions {
  const raw = ctx.config.checks["content.images"]?.options;
  const maxImageBytes =
    typeof raw?.["maxImageBytes"] === "number" && raw["maxImageBytes"] > 0
      ? raw["maxImageBytes"]
      : DEFAULT_MAX_IMAGE_BYTES;
  const ignore = Array.isArray(raw?.["ignore"])
    ? raw["ignore"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return { maxImageBytes, ignore };
}

const sampleList = (values: string[]): string =>
  `${values.slice(0, SAMPLE).join(", ")}${values.length > SAMPLE ? `, … (${String(values.length)} total)` : ""}`;

export const imagesCheck: Check = {
  id: "content.images",
  category: "content",
  description: "Images carry alt text and explicit dimensions, and image files are not oversized.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const options = imageOptions(ctx);
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    if (pages.length === 0) return { score: 100, findings: [] };

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    const allowedOrigins = allowedOriginsFor(new URL(ctx.baseUrl));
    /** unique image URL → first page referencing it */
    const internalImages = new Map<string, string>();
    const externalImages = new Map<string, string>();

    for (const page of pages) {
      const $ = pageDom(page);
      const missingAlt: string[] = [];
      const missingDimensions: string[] = [];
      $("img").each((_index, element) => {
        const img = $(element);
        const src = (img.attr("src") ?? "").trim();
        const display = src === "" ? "(inline image without src)" : src;
        if (options.ignore.some((pattern) => display.includes(pattern))) return;
        if (img.attr("alt") === undefined) missingAlt.push(display);
        if (img.attr("width") === undefined && img.attr("height") === undefined) {
          missingDimensions.push(display);
        }
        if (src !== "") {
          const resolved = normalizePageUrl(src, page.finalUrl);
          if (
            resolved !== undefined &&
            !options.ignore.some((pattern) => resolved.includes(pattern))
          ) {
            const target = allowedOrigins.has(new URL(resolved).origin)
              ? internalImages
              : externalImages;
            if (!target.has(resolved)) target.set(resolved, page.url);
          }
        }
      });
      if (missingAlt.length > 0) {
        record({
          severity: "error",
          url: page.url,
          message: `${String(missingAlt.length)} image(s) missing an alt attribute: ${sampleList(missingAlt)}`,
          recommendation:
            'Add alt text describing each image (or alt="" for purely decorative ones) — required for screen readers.',
        });
      }
      if (missingDimensions.length > 0) {
        record({
          severity: "warning",
          url: page.url,
          message: `${String(missingDimensions.length)} image(s) without width/height attributes: ${sampleList(missingDimensions)}`,
          recommendation:
            "Add explicit width and height so the browser reserves space and avoids layout shift.",
        });
      }
    }

    const probeCache = new Map<string, Promise<number | undefined>>();
    const contentLength = (url: string): Promise<number | undefined> => {
      const cached = probeCache.get(url);
      if (cached !== undefined) return cached;
      const result = (async (): Promise<number | undefined> => {
        try {
          let response = await ctx.fetch(url, { method: "HEAD" });
          if (response.status === 405 || response.status === 501) response = await ctx.fetch(url);
          const raw = response.headers["content-length"];
          const parsed = raw === undefined ? Number.NaN : Number(raw);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
        } catch {
          return undefined;
        }
      })();
      probeCache.set(url, result);
      return result;
    };

    const checkSize = async (imageUrl: string, pageUrl: string): Promise<void> => {
      const bytes = await contentLength(imageUrl);
      if (bytes !== undefined && bytes > options.maxImageBytes) {
        record({
          severity: "warning",
          url: pageUrl,
          message: `Oversized image (${String(Math.round(bytes / 1024))} KB, limit ${String(Math.round(options.maxImageBytes / 1024))} KB): ${imageUrl}`,
          recommendation:
            "Compress or resize the image (WebP/AVIF, responsive srcset) — heavy images are the top cause of slow LCP.",
        });
      }
    };

    const internalEntries = [...internalImages.entries()];
    if (internalEntries.length > INTERNAL_PROBE_LIMIT) {
      ctx.logger.debug("Internal image probe cap reached", {
        skipped: internalEntries.length - INTERNAL_PROBE_LIMIT,
      });
      internalEntries.length = INTERNAL_PROBE_LIMIT;
    }
    await Promise.all(internalEntries.map(([imageUrl, pageUrl]) => checkSize(imageUrl, pageUrl)));

    if (ctx.environment === "production") {
      const externalEntries = [...externalImages.entries()];
      if (externalEntries.length > EXTERNAL_PROBE_LIMIT) {
        ctx.logger.debug("External image probe cap reached", {
          skipped: externalEntries.length - EXTERNAL_PROBE_LIMIT,
        });
        externalEntries.length = EXTERNAL_PROBE_LIMIT;
      }
      await Promise.all(externalEntries.map(([imageUrl, pageUrl]) => checkSize(imageUrl, pageUrl)));
    }

    ctx.logger.debug("Image scan", {
      pagesChecked: pages.length,
      imagesProbed: probeCache.size,
      findings: findings.length,
    });
    const cleanPages = pages.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / pages.length), findings };
  },
};
