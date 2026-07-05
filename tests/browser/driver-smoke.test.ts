import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { probeBrowserCapability } from "../../src/browser/lazy-browser.js";
import { createPlaywrightDriver } from "../../src/browser/playwright-driver.js";

const hasBrowser = await probeBrowserCapability();

describe.skipIf(!hasBrowser)("playwright driver (real Chromium)", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<html><body><script>throw new Error("boom-smoke");</script></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
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
      expect(await driver.provider.cdpEndpoint()).not.toBe("");
    } finally {
      await driver.teardown();
    }
  }, 30_000);
});
