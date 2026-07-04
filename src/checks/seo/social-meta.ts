import type { CheerioAPI } from "cheerio";
import { allowedOriginsFor } from "../../crawl/crawler.js";
import { pageDom } from "../../crawl/page-dom.js";
import type { Check, Finding } from "../../types.js";

export interface SocialMeta {
  ogTagCount: number;
  ogTitle: string | undefined;
  ogDescription: string | undefined;
  ogImage: string | undefined;
  ogUrl: string | undefined;
  twitterCard: string | undefined;
}

const content = ($: CheerioAPI, selector: string): string | undefined => {
  const value = $(selector).first().attr("content")?.trim();
  return value === "" ? undefined : value;
};

export function extractSocialMeta($: CheerioAPI): SocialMeta {
  return {
    ogTagCount: $('meta[property^="og:" i]').length,
    ogTitle: content($, 'meta[property="og:title" i]'),
    ogDescription: content($, 'meta[property="og:description" i]'),
    ogImage:
      content($, 'meta[property="og:image" i]') ?? content($, 'meta[property="og:image:url" i]'),
    ogUrl: content($, 'meta[property="og:url" i]'),
    twitterCard:
      content($, 'meta[name="twitter:card" i]') ?? content($, 'meta[property="twitter:card" i]'),
  };
}

type ProbeResult =
  { kind: "status"; status: number; contentType: string } | { kind: "unreachable" };

export const socialMetaCheck: Check = {
  id: "seo.social-meta",
  category: "seo",
  description:
    "Pages carry Open Graph tags for link sharing, and og:image URLs are absolute and actually resolve.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
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
    const probeCache = new Map<string, Promise<ProbeResult>>();
    const probe = (url: string): Promise<ProbeResult> => {
      const cached = probeCache.get(url);
      if (cached !== undefined) return cached;
      const result = (async (): Promise<ProbeResult> => {
        try {
          let response = await ctx.fetch(url, { method: "HEAD" });
          if (response.status === 405 || response.status === 501) response = await ctx.fetch(url);
          return {
            kind: "status",
            status: response.status,
            contentType: response.headers["content-type"] ?? "",
          };
        } catch {
          return { kind: "unreachable" };
        }
      })();
      probeCache.set(url, result);
      return result;
    };

    /**
     * og:image URL → first page that referenced it, split by origin trust.
     * Probe volume is bounded by maxPages (one og:image per page via .first()).
     */
    const internalImages = new Map<string, string>();
    const externalImages = new Map<string, string>();

    for (const page of pages) {
      const meta = extractSocialMeta(pageDom(page));
      if (meta.ogTagCount === 0) {
        record({
          severity: "warning",
          url: page.url,
          message: "Page has no Open Graph tags.",
          recommendation:
            "Add og:title, og:description, og:image, and og:url so link shares render a proper preview.",
        });
        continue;
      }
      const missing: string[] = [];
      if (meta.ogTitle === undefined) missing.push("og:title");
      if (meta.ogDescription === undefined) missing.push("og:description");
      if (meta.ogImage === undefined) missing.push("og:image");
      if (meta.ogUrl === undefined) missing.push("og:url");
      for (const tag of missing) {
        record({
          severity: "warning",
          url: page.url,
          message: `Missing ${tag}.`,
          recommendation: `Add ${tag} — platforms use it directly when rendering shared links.`,
        });
      }
      if (meta.twitterCard === undefined) {
        record({
          severity: "info",
          url: page.url,
          message: "Missing twitter:card.",
          recommendation:
            'Add <meta name="twitter:card" content="summary_large_image"> for best Twitter/X rendering.',
        });
      }
      if (meta.ogImage !== undefined) {
        let parsed: URL | undefined;
        try {
          parsed = new URL(meta.ogImage);
        } catch {
          parsed = undefined;
        }
        if (parsed === undefined || !/^https?:$/.test(parsed.protocol)) {
          record({
            severity: "warning",
            url: page.url,
            message: `og:image is not an absolute URL: ${meta.ogImage}`,
            recommendation:
              "Use a fully-qualified https URL — platforms do not resolve relative og:image values.",
          });
        } else {
          const target = allowedOrigins.has(parsed.origin) ? internalImages : externalImages;
          if (!target.has(meta.ogImage)) target.set(meta.ogImage, page.url);
        }
      }
    }

    const checkImage = async (
      imageUrl: string,
      pageUrl: string,
      brokenSeverity: Finding["severity"],
    ): Promise<void> => {
      const result = await probe(imageUrl);
      if (result.kind === "unreachable" || result.status >= 400) {
        record({
          severity: brokenSeverity,
          url: pageUrl,
          message: `og:image does not resolve: ${imageUrl}${result.kind === "status" ? ` (HTTP ${String(result.status)})` : ""}`,
          recommendation:
            "Fix the image URL — a broken og:image makes every share of this page look broken.",
        });
        return;
      }
      if (result.contentType !== "" && !result.contentType.startsWith("image/")) {
        record({
          severity: "warning",
          url: pageUrl,
          message: `og:image is not an image (content-type ${result.contentType}): ${imageUrl}`,
          recommendation: "Point og:image at an actual image file (1200×630 recommended).",
        });
      }
    };

    await Promise.all(
      [...internalImages.entries()].map(([imageUrl, pageUrl]) =>
        checkImage(imageUrl, pageUrl, "error"),
      ),
    );
    if (ctx.environment === "production") {
      await Promise.all(
        [...externalImages.entries()].map(([imageUrl, pageUrl]) =>
          checkImage(imageUrl, pageUrl, "warning"),
        ),
      );
    }

    ctx.logger.debug("Social meta summary", {
      pagesChecked: pages.length,
      imagesProbed: probeCache.size,
      findings: findings.length,
    });

    const cleanPages = pages.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / pages.length), findings };
  },
};
