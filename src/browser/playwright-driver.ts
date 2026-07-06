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
        async runAxe(options): Promise<AxeRun> {
          let axeModule: unknown;
          try {
            // @ts-expect-error — @axe-core/playwright is an optional peer dep
            axeModule = await import("@axe-core/playwright"); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
          } catch {
            return { available: false, violations: [] };
          }
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
            const { injectAxe, getViolations } = axeModule as any;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            await injectAxe(page);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            const rawViolations = await getViolations(page, options?.standard, options?.ignore); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const violations = (rawViolations as any[]).map((v: any) => {
              return {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                id: v.id as string,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                impact: v.impact as "critical" | "serious" | "moderate" | "minor" | null,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                help: v.help as string,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                nodeCount: (v.nodes as unknown[]).length,
              };
            });
            return {
              available: true,
              violations,
            };
          } catch {
            return { available: true, violations: [] };
          }
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
