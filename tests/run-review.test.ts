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
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml") {
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
    const report = await runReview({ url: server.url, environment: "ci" });
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
    const report = await runReview({ url: server.url, environment: "ci" });
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
    const report = await runReview({ url: server.url, environment: "ci" });
    const seo = report.categories.find((category) => category.id === "seo");
    const check = seo?.checks.find((entry) => entry.id === "seo.sitemap-robots");
    expect(check?.status).toBe("fail");
    expect(
      check?.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("disallow"),
      ),
    ).toBe(true);
  });

  it("surfaces security header findings in ci and skips tls outside production", async () => {
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html lang="en"><head><title>t</title></head><body>ok</body></html>');
    });
    const report = await runReview({ url: server.url, environment: "ci" });
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
});
