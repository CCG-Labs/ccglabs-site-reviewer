import { afterEach, describe, expect, it } from "vitest";
import { SiteUnreachableError } from "../src/fetch/fetcher.js";
import { runReview } from "../src/engine/run-review.js";
import { reviewReportSchema } from "../src/report/schema.js";
import type { Check } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

// These integration tests exercise other checks in "ci"/"production" and don't care about
// performance.lighthouse; disabling it keeps them from paying for a real Lighthouse audit.
const NO_LIGHTHOUSE = { checks: { "performance.lighthouse": false } };

describe("runReview", () => {
  it("produces a schema-valid passing report for a healthy site", async () => {
    server = await startServer((req, res) => {
      const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
      if (req.url === "/robots.txt") {
        res.setHeader("content-type", "text/plain");
        res.end(`User-agent: *\nDisallow:\n\nSitemap: ${origin}/sitemap.xml\n`);
        return;
      }
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`,
        );
        return;
      }
      if (req.url !== "/") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end("<html></html>");
    });
    const report = await runReview({ url: server.url });
    expect(() => reviewReportSchema.parse(report)).not.toThrow();
    expect(report.grade).toBe("pass");
    expect(report.score).toBe(100);
    expect(report.environment).toBe("local");
    expect(report.target).toBe(server.url);
    expect(report.manualChecklist.length).toBeGreaterThan(0);
    expect(report.crawl.pagesScanned).toBeGreaterThanOrEqual(1);
    const category = report.categories.find((c) => c.id === "functionality");
    expect(category?.checks.map((c) => c.id)).toContain("functionality.reachable");
  });

  it("grades fail when a blocking check fails", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("broken");
    });
    const report = await runReview({ url: server.url });
    expect(report.grade).toBe("fail");
  });

  it("throws SiteUnreachableError for a network-level failure", async () => {
    await expect(runReview({ url: "http://127.0.0.1:1" })).rejects.toBeInstanceOf(
      SiteUnreachableError,
    );
  });

  it("throws SiteUnreachableError for a malformed URL", async () => {
    await expect(runReview({ url: "not a url" })).rejects.toBeInstanceOf(SiteUnreachableError);
  });

  it("runs custom checks and skips those not applicable to the environment", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const productionOnly: Check = {
      id: "custom.production-only",
      category: "operations",
      description: "only runs in production",
      environments: ["production"],
      blocking: false,
      weight: 1,
      run: () => Promise.resolve({ score: 100, findings: [] }),
    };
    const report = await runReview({
      url: server.url,
      environment: "local",
      config: { customChecks: [productionOnly] },
    });
    expect(report.skipped).toContainEqual({
      id: "custom.production-only",
      reason: 'not applicable in environment "local"',
    });
  });

  it("honors config overrides that disable a check", async () => {
    server = await startServer((req, res) => {
      if (req.url !== "/") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end("ok");
    });
    const report = await runReview({
      url: server.url,
      config: { checks: { "functionality.reachable": false } },
    });
    expect(report.skipped).toContainEqual({
      id: "functionality.reachable",
      reason: "disabled by config",
    });
    expect(report.grade).toBe("pass");
  });

  it("surfaces seo.meta-tags findings from crawled pages", async () => {
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/") {
        res.end(
          '<html lang="en"><head><title>Home</title><meta name="description" content="A perfectly reasonable description that sits comfortably within the limits."><link rel="canonical" href="/"></head><body><h1>Hi</h1><a href="/bare">bare</a></body></html>',
        );
      } else {
        res.end("<html><head></head><body>no meta at all</body></html>");
      }
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const seo = report.categories.find((category) => category.id === "seo");
    const check = seo?.checks.find((entry) => entry.id === "seo.meta-tags");
    expect(check?.status).toBe("fail");
    expect(check?.findings.some((finding) => finding.url?.endsWith("/bare") ?? false)).toBe(true);
    expect(report.grade).toBe("fail"); // blocking check failed
  });

  it("surfaces broken internal links from crawled pages", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/missing.css" || req.url === "/gone") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<html lang="en"><head><title>Home</title><meta name="description" content="A perfectly reasonable description that sits comfortably within the limits."><link rel="canonical" href="/"><link rel="stylesheet" href="/missing.css"></head><body><h1>Hi</h1><a href="/gone">gone</a></body></html>',
      );
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const functionality = report.categories.find((category) => category.id === "functionality");
    const check = functionality?.checks.find((entry) => entry.id === "functionality.links");
    expect(check?.status).toBe("fail");
    const messages = (check?.findings ?? []).map((finding) => finding.message).join(" ");
    expect(messages).toContain("/gone");
    expect(messages).toContain("/missing.css");
  });

  it("surfaces sitemap and robots issues from a live crawl", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.setHeader("content-type", "text/plain");
        res.end("User-agent: *\nDisallow: /secret\n");
        return;
      }
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${server?.url ?? ""}/secret/page</loc></url></urlset>`,
        );
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const seo = report.categories.find((category) => category.id === "seo");
    const check = seo?.checks.find((entry) => entry.id === "seo.sitemap-robots");
    expect(check?.status).toBe("fail");
    expect(
      check?.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("disallow"),
      ),
    ).toBe(true);
  });

  it("surfaces malformed JSON-LD from crawled pages", async () => {
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<html lang="en"><head><title>t</title><script type="application/ld+json">{broken</script></head><body>ok</body></html>',
      );
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const seo = report.categories.find((category) => category.id === "seo");
    const check = seo?.checks.find((entry) => entry.id === "seo.structured-data");
    expect(check?.status).toBe("fail");
    expect(
      check?.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("not valid JSON"),
      ),
    ).toBe(true);
  });

  it("surfaces broken og:image from crawled pages", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/share.png") {
        res.statusCode = 404;
        res.end("gone");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<html lang="en"><head><title>t</title><meta property="og:title" content="T"><meta property="og:image" content="${server?.url ?? ""}/share.png"></head><body>ok</body></html>`,
      );
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const seo = report.categories.find((category) => category.id === "seo");
    const check = seo?.checks.find((entry) => entry.id === "seo.social-meta");
    expect(check?.status).toBe("fail");
    expect(
      check?.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("/share.png"),
      ),
    ).toBe(true);
  });

  it("surfaces security header findings in ci and skips tls outside production", async () => {
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const security = report.categories.find((category) => category.id === "security");
    const headersCheck = security?.checks.find((entry) => entry.id === "security.headers");
    expect(
      headersCheck?.findings.some((finding) => finding.message.includes("X-Content-Type-Options")),
    ).toBe(true);
    expect(report.skipped).toContainEqual({
      id: "security.tls",
      reason: 'not applicable in environment "ci"',
    });
  });

  it("surfaces placeholder text and image hygiene issues from crawled pages", async () => {
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<html lang="en"><head><title>t</title></head><body><p>Lorem ipsum dolor sit amet.</p><img src="/logo.png"></body></html>',
      );
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const content = report.categories.find((category) => category.id === "content");
    const placeholders = content?.checks.find((entry) => entry.id === "content.placeholders");
    const images = content?.checks.find((entry) => entry.id === "content.images");
    expect(placeholders?.status).toBe("fail");
    expect(placeholders?.findings.some((finding) => finding.message.includes("lorem ipsum"))).toBe(
      true,
    );
    // content.images softens missing-alt to a warning outside production (mirrors
    // security.headers' ci-softening precedent) — this run's environment is "ci".
    expect(images?.status).toBe("warn");
    expect(images?.findings.some((finding) => finding.message.includes("alt"))).toBe(true);
  });

  it("surfaces soft-404 and exposed-file issues from a live crawl", async () => {
    server = await startServer((req, res) => {
      if (req.url?.startsWith("/.env")) {
        res.setHeader("content-type", "text/plain");
        res.end("DB_PASSWORD=hunter2");
        return;
      }
      // soft-404: everything returns 200 HTML
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
    });
    const report = await runReview({
      url: server.url,
      environment: "production",
      config: NO_LIGHTHOUSE,
    });
    const functionality = report.categories.find((category) => category.id === "functionality");
    const security = report.categories.find((category) => category.id === "security");
    expect(
      functionality?.checks
        .find((entry) => entry.id === "functionality.error-pages")
        ?.findings.some((finding) => finding.message.includes("soft 404")),
    ).toBe(true);
    expect(
      security?.checks
        .find((entry) => entry.id === "security.sensitive-files")
        ?.findings.some((finding) => finding.message.includes("/.env")),
    ).toBe(true);
  });

  it("skips browser checks (with the extras hint) when playwright is not injected", async () => {
    server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
    });
    // In the fast test path, the real capability probe finds playwright as a
    // devDependency — so force the unavailable path via a test-only override.
    const report = await runReview({
      url: server.url,
      environment: "ci",
      browserCapability: false,
    });
    expect(report.skipped.some((skip) => skip.id === "functionality.console-errors")).toBe(true);
  });

  it("surfaces console errors end-to-end when a browser is available", async () => {
    const { probeBrowserCapability } = await import("../src/browser/lazy-browser.js");
    if (!(await probeBrowserCapability())) return; // skip on a lean checkout
    server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<html lang="en"><head><title>t</title></head><body><script>undefinedFn()</script></body></html>',
      );
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const check = report.categories
      .find((c) => c.id === "functionality")
      ?.checks.find((e) => e.id === "functionality.console-errors");
    expect(check?.status).toBe("fail");
    expect(check?.findings.some((f) => f.severity === "error")).toBe(true);
  }, 30_000);

  it("completes the run and keeps fetch-tier checks when the browser fails to launch", async () => {
    server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
    });
    const report = await runReview({
      url: server.url,
      environment: "ci",
      browserCapability: true,
      browserDriverFactory: () => Promise.reject(new Error("Chromium failed to launch")),
    });
    // fetch-tier checks are still present and the report is fully produced
    expect(
      report.categories.some((c) =>
        c.checks.some((check) => check.id === "functionality.reachable"),
      ),
    ).toBe(true);
    const consoleErrorsCheck = report.categories
      .find((c) => c.id === "functionality")
      ?.checks.find((e) => e.id === "functionality.console-errors");
    expect(consoleErrorsCheck?.status).toBe("error");
  });

  it("surfaces accessibility violations end-to-end when a browser is available", async () => {
    const { probeBrowserCapability } = await import("../src/browser/lazy-browser.js");
    if (!(await probeBrowserCapability())) return;
    server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<html lang="en"><head><title>t</title></head><body><img src="/x.png"></body></html>',
      );
    });
    const report = await runReview({ url: server.url, environment: "ci", config: NO_LIGHTHOUSE });
    const check = report.categories
      .find((c) => c.id === "accessibility")
      ?.checks.find((e) => e.id === "accessibility.axe");
    expect(check).toBeDefined();
    expect(check?.findings.some((f) => f.message.includes("image-alt"))).toBe(true);
  }, 30_000);
});
