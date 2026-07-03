import type { Check } from "../../types.js";

export const crawlCoverageCheck: Check = {
  id: "functionality.crawl-coverage",
  category: "functionality",
  description: "The crawl covered the discoverable site without hitting the page cap.",
  environments: ["local", "ci", "production"],
  blocking: false,
  weight: 1,
  run(ctx) {
    const stats = ctx.pages.stats();
    ctx.logger.debug("Crawl stats", stats);
    if (stats.capped) {
      return Promise.resolve({
        score: 50,
        findings: [
          {
            severity: "warning" as const,
            message: `Crawl discovery hit the ${String(ctx.config.maxPages)} page cap after scanning ${String(stats.pagesScanned)} pages — results cover only part of the site.`,
            recommendation:
              "Raise maxPages in the config (or --max-pages) to cover the full site, or scope the review to a smaller section. Do not treat this report as full-site coverage.",
          },
        ],
      });
    }
    return Promise.resolve({ score: 100, findings: [] });
  },
};
