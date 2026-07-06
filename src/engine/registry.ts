import { axeCheck } from "../checks/accessibility/axe.js";
import { imagesCheck } from "../checks/content/images.js";
import { placeholdersCheck } from "../checks/content/placeholders.js";
import { consoleErrorsCheck } from "../checks/functionality/console-errors.js";
import { crawlCoverageCheck } from "../checks/functionality/crawl-coverage.js";
import { errorPagesCheck } from "../checks/functionality/error-pages.js";
import { linksCheck } from "../checks/functionality/links.js";
import { reachableCheck } from "../checks/functionality/reachable.js";
import { lighthouseCheck } from "../checks/performance/lighthouse.js";
import { metaTagsCheck } from "../checks/seo/meta-tags.js";
import { sitemapRobotsCheck } from "../checks/seo/sitemap-robots.js";
import { socialMetaCheck } from "../checks/seo/social-meta.js";
import { structuredDataCheck } from "../checks/seo/structured-data.js";
import { securityHeadersCheck } from "../checks/security/headers.js";
import { sensitiveFilesCheck } from "../checks/security/sensitive-files.js";
import { securityTlsCheck } from "../checks/security/tls.js";
import type { Check } from "../types.js";

export const builtinChecks: Check[] = [
  reachableCheck,
  crawlCoverageCheck,
  errorPagesCheck,
  consoleErrorsCheck,
  axeCheck,
  lighthouseCheck,
  linksCheck,
  metaTagsCheck,
  sitemapRobotsCheck,
  structuredDataCheck,
  socialMetaCheck,
  placeholdersCheck,
  imagesCheck,
  securityHeadersCheck,
  securityTlsCheck,
  sensitiveFilesCheck,
];
