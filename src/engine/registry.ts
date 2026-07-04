import { crawlCoverageCheck } from "../checks/functionality/crawl-coverage.js";
import { linksCheck } from "../checks/functionality/links.js";
import { reachableCheck } from "../checks/functionality/reachable.js";
import { metaTagsCheck } from "../checks/seo/meta-tags.js";
import { sitemapRobotsCheck } from "../checks/seo/sitemap-robots.js";
import type { Check } from "../types.js";

export const builtinChecks: Check[] = [
  reachableCheck,
  crawlCoverageCheck,
  linksCheck,
  metaTagsCheck,
  sitemapRobotsCheck,
];
