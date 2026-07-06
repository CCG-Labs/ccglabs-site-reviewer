import {
  BrowserLaunchError,
  type AxeRun,
  type BrowserPage,
  type BrowserProvider,
  type FailedRequest,
} from "./types.js";

const NAV_TIMEOUT_MS = 30_000;

/**
 * The single seam that imports playwright. Launches one headless Chromium and
 * returns a provider that hands out isolated pages plus a teardown closure.
 */
export async function createPlaywrightDriver(): Promise<{
  provider: BrowserProvider;
  teardown: () => Promise<void>;
}> {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new BrowserLaunchError(
      `playwright import failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new BrowserLaunchError(
      `Chromium failed to launch — run "npx playwright install chromium": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const provider: BrowserProvider = {
    async newPage(): Promise<BrowserPage> {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      return {
        onError(handler) {
          // console.error is app-level logging (often benign/third-party) and is
          // intentionally not collected — only uncaught exceptions signal a
          // functional defect.
          page.on("pageerror", (error) => {
            handler(error.message);
          });
        },
        onRequestFailed(handler) {
          page.on("requestfailed", (request) => {
            const failure: FailedRequest = {
              url: request.url(),
              failure: request.failure()?.errorText ?? "unknown",
            };
            handler(failure);
          });
        },
        onRequest(handler) {
          page.on("request", (request) => {
            handler(request.url(), request.method());
          });
        },
        async goto(url) {
          const response = await page.goto(url, { waitUntil: "load" });
          return response?.status() ?? 0;
        },
        async content() {
          return page.content();
        },
        async runAxe(options = {}): Promise<AxeRun> {
          let AxeBuilder;
          try {
            ({ default: AxeBuilder } = await import("@axe-core/playwright"));
          } catch {
            return { available: false, violations: [] };
          }
          let builder = new AxeBuilder({ page });
          if (options.standard !== undefined && options.standard.length > 0) {
            builder = builder.withTags(options.standard);
          }
          if (options.ignore !== undefined && options.ignore.length > 0) {
            builder = builder.disableRules(options.ignore);
          }
          const results = await builder.analyze();
          return {
            available: true,
            violations: results.violations.map((violation) => ({
              id: violation.id,
              impact: violation.impact ?? null,
              help: violation.help,
              nodeCount: violation.nodes.length,
            })),
          };
        },
        async close() {
          await context.close();
        },
      };
    },
  };

  return {
    provider,
    teardown: async () => {
      await browser.close();
    },
  };
}
