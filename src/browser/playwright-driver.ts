import net from "node:net";
import {
  BrowserLaunchError,
  type AxeRun,
  type BrowserPage,
  type BrowserProvider,
  type FailedRequest,
  type LighthouseRun,
} from "./types.js";

const NAV_TIMEOUT_MS = 30_000;

/**
 * An OS-assigned free TCP port on 127.0.0.1. Freed before Chromium binds it —
 * the TOCTOU window is negligible for a local, short-lived tool process.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a CDP debugging port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

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
  const cdpPort = await freePort();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      // 127.0.0.1-bound CDP port so Lighthouse can drive this same Chromium.
      args: [`--remote-debugging-port=${String(cdpPort)}`],
    });
  } catch (error) {
    throw new BrowserLaunchError(
      `Chromium failed to launch — run "npx playwright install chromium": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const provider: BrowserProvider = {
    async runLighthouse(url: string): Promise<LighthouseRun> {
      let lighthouse;
      try {
        ({ default: lighthouse } = await import("lighthouse"));
      } catch {
        return {
          available: false,
          categories: { performance: null, accessibility: null, bestPractices: null, seo: null },
          metrics: { lcpMs: null, cls: null, tbtMs: null },
        };
      }
      const result = await lighthouse(url, {
        port: cdpPort,
        output: "json",
        logLevel: "error",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      });
      if (result === undefined) throw new Error("Lighthouse produced no result");
      const lhr = result.lhr;
      const score = (id: string): number | null => {
        const raw = lhr.categories[id]?.score;
        return typeof raw === "number" ? Math.round(raw * 100) : null;
      };
      const metric = (id: string): number | null => {
        const raw = lhr.audits[id]?.numericValue;
        return typeof raw === "number" ? raw : null;
      };
      return {
        available: true,
        categories: {
          performance: score("performance"),
          accessibility: score("accessibility"),
          bestPractices: score("best-practices"),
          seo: score("seo"),
        },
        metrics: {
          lcpMs: metric("largest-contentful-paint"),
          cls: metric("cumulative-layout-shift"),
          tbtMs: metric("total-blocking-time"),
        },
      };
    },
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
