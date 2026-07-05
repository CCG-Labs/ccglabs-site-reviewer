import { describe, expect, it } from "vitest";
import { fakeBrowser } from "./helpers/fake-browser.js";

describe("fakeBrowser", () => {
  it("replays scripted errors and status for a page", async () => {
    const browser = fakeBrowser({
      "https://x.com/": { status: 200, errors: ["Uncaught TypeError: x is not a function"] },
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.onError((message) => errors.push(message));
    const status = await page.goto("https://x.com/");
    await page.close();
    expect(status).toBe(200);
    expect(errors).toEqual(["Uncaught TypeError: x is not a function"]);
  });

  it("replays failed requests and captures outgoing requests", async () => {
    const browser = fakeBrowser({
      "https://x.com/": {
        failedRequests: [{ url: "https://x.com/app.js", failure: "net::ERR_ABORTED" }],
        requests: [{ url: "https://ga.example/collect", method: "POST" }],
      },
    });
    const page = await browser.newPage();
    const failed: string[] = [];
    const seen: string[] = [];
    page.onRequestFailed((request) => failed.push(request.url));
    page.onRequest((url) => seen.push(url));
    await page.goto("https://x.com/");
    expect(failed).toEqual(["https://x.com/app.js"]);
    expect(seen).toContain("https://ga.example/collect");
  });

  it("defaults to status 200 and no events for an unscripted URL", async () => {
    const browser = fakeBrowser({});
    const page = await browser.newPage();
    const errors: string[] = [];
    page.onError((message) => errors.push(message));
    expect(await page.goto("https://x.com/unknown")).toBe(200);
    expect(errors).toEqual([]);
  });
});
