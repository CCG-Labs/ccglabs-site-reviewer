import packageJson from "../../package.json" with { type: "json" };
import { createLazyBrowser, probeBrowserCapability } from "../browser/lazy-browser.js";
import { createPlaywrightDriver } from "../browser/playwright-driver.js";
import { resolveConfig } from "../config/resolve.js";
import { allowedOriginsFor, crawlSite } from "../crawl/crawler.js";
import { createFetcher, SiteUnreachableError } from "../fetch/fetcher.js";
import { MANUAL_CHECKLIST } from "../report/manual-checklist.js";
import {
  REPORT_VERSION,
  reviewReportSchema,
  type CategoryReport,
  type ReviewReport,
} from "../report/schema.js";
import type { CategoryId, Environment, SiteReviewConfig } from "../types.js";
import { applyOverride, partitionChecks, runChecks, type ExecutedCheck } from "./runner.js";
import { builtinChecks } from "./registry.js";
import { categoryScore, computeGrade, overallScore } from "./score.js";

export interface RunReviewOptions {
  url: string;
  environment?: Environment;
  /** API-layer config */
  config?: SiteReviewConfig;
  /** pre-loaded config file contents (the CLI loads and passes this) */
  configFile?: SiteReviewConfig;
  /** CLI-flag layer; wins over everything */
  cliConfig?: SiteReviewConfig;
  /** test-only: bypass the capability probe */
  browserCapability?: boolean;
  /** test-only: inject a driver factory instead of the real createPlaywrightDriver (e.g. to simulate launch failure) */
  browserDriverFactory?: () => ReturnType<typeof createPlaywrightDriver>;
}

export async function runReview(options: RunReviewOptions): Promise<ReviewReport> {
  const startedAt = new Date();
  const cliLayer: SiteReviewConfig = {
    ...options.cliConfig,
    ...(options.environment !== undefined && { environment: options.environment }),
  };
  const config = resolveConfig({ file: options.configFile, api: options.config, cli: cliLayer });

  let targetUrl: URL;
  try {
    targetUrl = new URL(options.url);
  } catch {
    throw new SiteUnreachableError(`Cannot reach ${options.url}: invalid URL`);
  }

  const fetchFn = createFetcher({
    requestHeaders: config.requestHeaders,
    trustedOrigins: allowedOriginsFor(targetUrl),
  });

  try {
    await fetchFn(options.url, { method: "HEAD" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SiteUnreachableError(`Cannot reach ${options.url}: ${message}`);
  }

  const pages = await crawlSite({
    baseUrl: options.url,
    fetch: fetchFn,
    maxPages: config.maxPages,
  });

  const browserAvailable = options.browserCapability ?? (await probeBrowserCapability());
  const lazyBrowser = browserAvailable
    ? createLazyBrowser(options.browserDriverFactory ?? (() => createPlaywrightDriver()))
    : undefined;

  const allChecks = [...builtinChecks, ...config.customChecks].map((check) =>
    applyOverride(check, config.checks[check.id]),
  );
  const { toRun, skipped } = partitionChecks(
    allChecks,
    config.environment,
    config.checks,
    browserAvailable,
  );
  let executed: ExecutedCheck[];
  try {
    executed = await runChecks(toRun, {
      baseUrl: options.url,
      environment: config.environment,
      config,
      pages,
      fetch: fetchFn,
      browser: lazyBrowser?.provider,
    });
  } finally {
    await lazyBrowser?.teardown();
  }

  const byCategory = new Map<CategoryId, ExecutedCheck[]>();
  for (const result of executed) {
    const list = byCategory.get(result.check.category) ?? [];
    list.push(result);
    byCategory.set(result.check.category, list);
  }

  const categories: CategoryReport[] = [...byCategory.entries()].map(([id, results]) => ({
    id,
    score: categoryScore(
      results.map((r) => ({ score: r.score, weight: r.check.weight, status: r.status })),
    ),
    checks: results.map((r) => ({
      id: r.check.id,
      status: r.status,
      score: r.score,
      blocking: r.check.blocking,
      findings: r.findings,
      debug: r.debug,
    })),
  }));

  const overall = overallScore(categories.map((c) => c.score));
  const anyBlockingFailed = executed.some((r) => r.check.blocking && r.status === "fail");

  const report: ReviewReport = {
    reportVersion: REPORT_VERSION,
    tool: { name: packageJson.name, version: packageJson.version },
    target: options.url,
    environment: config.environment,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    crawl: pages.stats(),
    grade: computeGrade({
      overall,
      failThreshold: config.failThreshold,
      anyBlockingFailed,
    }),
    score: overall,
    categories,
    skipped,
    manualChecklist: MANUAL_CHECKLIST,
  };

  return reviewReportSchema.parse(report);
}
