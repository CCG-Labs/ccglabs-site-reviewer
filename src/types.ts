export type Environment = "local" | "ci" | "production";

export const CATEGORY_IDS = [
  "functionality",
  "performance",
  "accessibility",
  "seo",
  "security",
  "content",
  "operations",
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  message: string;
  recommendation: string;
  url?: string;
  details?: unknown;
}

export interface CheckOutcome {
  /** 0–100 */
  score: number;
  /** empty array means the check passed */
  findings: Finding[];
}

export interface Logger {
  debug(message: string, data?: unknown): void;
}

export interface FetchResult {
  /** final URL after redirects */
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  redirected: boolean;
  durationMs: number;
}

export type RateLimitedFetch = (url: string, init?: { method?: string }) => Promise<FetchResult>;

export interface CrawledPage {
  /** normalized URL as requested by the crawler */
  url: string;
  /** final URL after redirects */
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** HTML body text; empty for non-HTML responses — checks needing raw assets should fetch them directly. */
  body: string;
  redirected: boolean;
  durationMs: number;
}

export interface CrawlStats {
  /** unique URLs discovered (queued), whether or not they were fetched */
  pagesDiscovered: number;
  /** pages successfully fetched and stored */
  pagesScanned: number;
  /** true when maxPages truncated discovery — coverage is partial */
  capped: boolean;
}

export interface PageStore {
  /** look up a page by URL (normalized internally) */
  get(url: string): CrawledPage | undefined;
  all(): CrawledPage[];
  /** pages whose content-type is HTML — what most checks iterate */
  htmlPages(): CrawledPage[];
  stats(): CrawlStats;
}

export interface CheckContext {
  baseUrl: string;
  environment: Environment;
  config: ResolvedConfig;
  /** crawl results shared by all checks — one fetch per page for the whole run */
  pages: PageStore;
  fetch: RateLimitedFetch;
  /** present only when the browser capability is available; undefined otherwise */
  browser?: import("./browser/types.js").BrowserProvider;
  logger: Logger;
}

export interface Check {
  /** e.g. "seo.meta-tags" */
  id: string;
  category: CategoryId;
  description: string;
  /** environments where this check applies; auto-skipped elsewhere */
  environments: Environment[];
  /** a failing blocking check fails the whole run regardless of score */
  blocking: boolean;
  /** relative weight within its category */
  weight: number;
  /** capability this check needs; absent = fetch-tier default (no browser) */
  requires?: "browser";
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export interface CheckOverride {
  enabled?: boolean;
  blocking?: boolean;
  weight?: number;
  options?: Record<string, unknown>;
}

export interface SiteReviewConfig {
  environment?: Environment;
  maxPages?: number;
  failThreshold?: number;
  browserSampleSize?: number;
  requestHeaders?: Record<string, string>;
  checks?: Record<string, boolean | CheckOverride>;
  environments?: Partial<Record<Environment, Omit<SiteReviewConfig, "environments">>>;
  customChecks?: Check[];
}

export interface ResolvedConfig {
  environment: Environment;
  maxPages: number;
  failThreshold: number;
  browserSampleSize: number;
  requestHeaders: Record<string, string>;
  checks: Record<string, CheckOverride>;
  customChecks: Check[];
}
