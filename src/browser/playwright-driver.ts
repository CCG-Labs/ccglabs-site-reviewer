import {
  BrowserLaunchError,
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
          page.on("pageerror", (error) => {
            handler(error.message);
          });
          page.on("console", (message) => {
            if (message.type() === "error") handler(message.text());
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
        async close() {
          await context.close();
        },
      };
    },
    async cdpEndpoint(): Promise<string> {
      // browser.wsEndpoint() only exists on a BrowserServer (launchServer());
      // a Browser from launch() exposes the equivalent via bind(), which
      // starts a websocket server for other clients to connect to. Used by
      // Lighthouse in a later PR.
      const { endpoint } = await browser.bind("site-reviewer", {
        host: "127.0.0.1",
        port: 0,
      });
      return endpoint;
    },
  };

  return {
    provider,
    teardown: async () => {
      await browser.close();
    },
  };
}
