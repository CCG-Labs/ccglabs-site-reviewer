import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { probeBrowserCapability } from "../../src/browser/lazy-browser.js";
import { createPlaywrightDriver } from "../../src/browser/playwright-driver.js";

const hasBrowser = await probeBrowserCapability();

describe.skipIf(!hasBrowser)("playwright driver (real Chromium)", () => {
  let server: Server;
  let url: string;
  let consoleErrorUrl: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/console-error") {
        res.end('<html><body><script>console.error("noisy-third-party");</script></body></html>');
        return;
      }
      res.end('<html><body><script>throw new Error("boom-smoke");</script></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    url = `${base}/`;
    consoleErrorUrl = `${base}/console-error`;
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
      page.onError((message) => errors.push(message));
      const status = await page.goto(url);
      await page.close();
      expect(status).toBe(200);
      expect(errors.join(" ")).toContain("boom-smoke");
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
});
