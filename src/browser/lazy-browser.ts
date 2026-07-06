import type { BrowserPage, BrowserProvider, LighthouseRun } from "./types.js";

/** True iff the browser peer dependency can be imported. */
export async function probeBrowserCapability(
  importer: () => Promise<unknown> = () => import("playwright"),
): Promise<boolean> {
  try {
    await importer();
    return true;
  } catch {
    return false;
  }
}

interface Driver {
  provider: BrowserProvider;
  teardown: () => Promise<void>;
}

/**
 * Wrap a driver factory so the real browser launches only on first use and is
 * torn down at most once. If no page is ever requested, no browser launches and
 * teardown is a no-op.
 */
export function createLazyBrowser(driverFactory: () => Promise<Driver>): {
  provider: BrowserProvider;
  teardown: () => Promise<void>;
} {
  let driver: Promise<Driver> | undefined;
  let teardownPromise: Promise<void> | undefined;
  const ensure = (): Promise<Driver> => {
    driver ??= driverFactory();
    return driver;
  };
  return {
    provider: {
      async newPage(): Promise<BrowserPage> {
        return (await ensure()).provider.newPage();
      },
      async runLighthouse(url: string): Promise<LighthouseRun> {
        return (await ensure()).provider.runLighthouse(url);
      },
    },
    async teardown(): Promise<void> {
      if (driver === undefined) return;
      const pending = driver;
      driver = undefined;
      teardownPromise ??= (async () => {
        try {
          const resolved = await pending;
          await resolved.teardown();
        } catch {
          // launch failed or close failed; nothing to clean up either way
        }
      })();
      await teardownPromise;
    },
  };
}
