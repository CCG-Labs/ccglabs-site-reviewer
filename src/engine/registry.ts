import { crawlCoverageCheck } from "../checks/functionality/crawl-coverage.js";
import { reachableCheck } from "../checks/functionality/reachable.js";
import { metaTagsCheck } from "../checks/seo/meta-tags.js";
import type { Check } from "../types.js";

export const builtinChecks: Check[] = [reachableCheck, crawlCoverageCheck, metaTagsCheck];
