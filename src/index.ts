export { runReview, type RunReviewOptions } from "./engine/run-review.js";
export { defineConfig } from "./config/define.js";
export { builtinChecks } from "./engine/registry.js";
export {
  createFetcher,
  isFollowableRedirect,
  SiteUnreachableError,
  BodySizeCapError,
  TooManyRedirectsError,
  type FetcherOptions,
} from "./fetch/fetcher.js";
export {
  REPORT_VERSION,
  reviewReportSchema,
  type CategoryReport,
  type CheckReport,
  type ReviewReport,
} from "./report/schema.js";
export type {
  CategoryId,
  Check,
  CheckContext,
  CheckOutcome,
  CheckOverride,
  Environment,
  Finding,
  SiteReviewConfig,
} from "./types.js";

export const TOOL_NAME = "@ccglabs/site-reviewer";
