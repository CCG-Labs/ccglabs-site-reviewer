import { imagesCheck } from "../checks/content/images.js";
import { placeholdersCheck } from "../checks/content/placeholders.js";
import { crawlCoverageCheck } from "../checks/functionality/crawl-coverage.js";
import { errorPagesCheck } from "../checks/functionality/error-pages.js";
import { linksCheck } from "../checks/functionality/links.js";
import { reachableCheck } from "../checks/functionality/reachable.js";
import { metaTagsCheck } from "../checks/seo/meta-tags.js";
import { sitemapRobotsCheck } from "../checks/seo/sitemap-robots.js";
import { socialMetaCheck } from "../checks/seo/social-meta.js";
import { structuredDataCheck } from "../checks/seo/structured-data.js";
import { securityHeadersCheck } from "../checks/security/headers.js";
import { securityTlsCheck } from "../checks/security/tls.js";
import type { Check } from "../types.js";

export const builtinChecks: Check[] = [
  reachableCheck,
  crawlCoverageCheck,
  errorPagesCheck,
  linksCheck,
  metaTagsCheck,
  sitemapRobotsCheck,
  structuredDataCheck,
  socialMetaCheck,
  placeholdersCheck,
  imagesCheck,
  securityHeadersCheck,
  securityTlsCheck,
];
