import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { probeBrowserCapability } from "../../src/browser/lazy-browser.js";
import { createPlaywrightDriver } from "../../src/browser/playwright-driver.js";

const hasBrowser = await probeBrowserCapability();

describe("playwright driver — CDP port allocation", () => {
  it("propagates a failure from the free-port probe socket's close()", async () => {
    const closeSpy = vi.spyOn(net.Server.prototype, "close").mockImplementationOnce(function (
      this: net.Server,
      callback?: (err?: Error) => void,
    ) {
      callback?.(new Error("close failed"));
      return this;
    });
    try {
      await expect(createPlaywrightDriver()).rejects.toThrow("close failed");
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe.skipIf(!hasBrowser)("playwright driver (real Chromium)", () => {
  let server: Server;
  let url: string;
  let consoleErrorUrl: string;
  let perfUrl: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/console-error") {
        res.end('<html><body><script>console.error("noisy-third-party");</script></body></html>');
        return;
      }
      if (req.url === "/perf") {
        res.end("<html><head><title>perf</title></head><body><h1>hello</h1></body></html>");
        return;
      }
      res.end(
        '<html><body><img src="http://127.0.0.1:1/nope.png"><script>throw new Error("boom-smoke");</script></body></html>',
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    url = `${base}/`;
    consoleErrorUrl = `${base}/console-error`;
    perfUrl = `${base}/perf`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  );

  it("captures a real uncaught page error", async () => {
    const driver = await createPlaywrightDriver();
    try {
      const page = await driver.provider.newPage();
      const errors: string[] = [];
      const requested: string[] = [];
      const failed: string[] = [];
      page.onError((message) => errors.push(message));
      page.onRequest((requestUrl) => requested.push(requestUrl));
      page.onRequestFailed((request) => failed.push(request.url));
      const status = await page.goto(url);
      const html = await page.content();
      await page.close();
      expect(status).toBe(200);
      expect(errors.join(" ")).toContain("boom-smoke");
      expect(html).toContain("boom-smoke");
      expect(requested).toContain(url);
      expect(failed).toContain("http://127.0.0.1:1/nope.png");
    } finally {
      await driver.teardown();
    }
  }, 30_000);

  it("does not treat console.error as a defect (only uncaught exceptions)", async () => {
    const driver = await createPlaywrightDriver();
    try {
      const page = await driver.provider.newPage();
      const errors: string[] = [];
      page.onError((message) => errors.push(message));
      const status = await page.goto(consoleErrorUrl);
      await page.close();
      expect(status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      await driver.teardown();
    }
  }, 30_000);

  it("runs a real axe scan and reports violations", async () => {
    const server2 = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<html lang="en"><body><img src="/x.png"></body></html>');
    });
    await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
    const axeUrl = `http://127.0.0.1:${String((server2.address() as AddressInfo).port)}/`;
    const driver = await createPlaywrightDriver();
    try {
      const page = await driver.provider.newPage();
      await page.goto(axeUrl);
      const run = await page.runAxe({ standard: ["wcag2a"], ignore: ["region"] });
      expect(run.available).toBe(true);
      expect(run.violations.some((v) => v.id === "image-alt")).toBe(true);
      expect(run.violations.some((v) => v.id === "region")).toBe(false);
    } finally {
      await driver.teardown();
      await new Promise<void>((r) => {
        server2.close(() => {
          r();
        });
      });
    }
  }, 30_000);

  it("runs a real Lighthouse audit over the shared Chromium's CDP port", async () => {
    const driver = await createPlaywrightDriver();
    try {
      const run = await driver.provider.runLighthouse(perfUrl);
      expect(run.available).toBe(true);
      expect(run.categories.performance).toBeGreaterThanOrEqual(0);
      expect(run.categories.performance).toBeLessThanOrEqual(100);
      expect(run.metrics.lcpMs).toBeGreaterThan(0);
    } finally {
      await driver.teardown();
    }
  }, 120_000);
});
