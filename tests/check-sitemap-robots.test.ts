import { describe, expect, it } from "vitest";
import { sitemapRobotsCheck } from "../src/checks/seo/sitemap-robots.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const sitemapXml = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;

const routesFetch =
  (routes: Record<string, { status: number; body?: string }>) =>
  (url: string): Promise<FetchResult> => {
    const route = routes[url] ?? { status: 404 };
    return Promise.resolve({
      url,
      status: route.status,
      ok: route.status < 300,
      headers: { "content-type": "application/xml" },
      body: route.body ?? "",
      redirected: false,
      durationMs: 1,
    });
  };

const goodBody = `<html lang="en"><head><title>t</title></head><body></body></html>`;

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  routes: Record<string, { status: number; body?: string }>,
  environment: Environment = "production",
  stats: Parameters<typeof fixturePageStore>[1] = {},
): CheckContext => ({
  baseUrl: "https://example.com",
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    requestHeaders: {},
    checks: {},
    customChecks: [],
  },
  pages: fixturePageStore(pages, stats),
  fetch: routesFetch(routes),
  logger: { debug: () => undefined },
});

const ROBOTS = "https://example.com/robots.txt";
const SITEMAP = "https://example.com/sitemap.xml";

describe("seo.sitemap-robots", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("seo.sitemap-robots");
  });

  it("passes a healthy site with a complete sitemap and sane robots", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: goodBody },
          { url: "https://example.com/about", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/", "https://example.com/about"]),
          },
          [ROBOTS]: { status: 200, body: `User-agent: *\nDisallow:\n\nSitemap: ${SITEMAP}\n` },
        },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns when sitemap and robots are missing, and skips the reference check", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {}),
    );
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings.every((finding) => finding.severity === "warning")).toBe(true);
    expect(outcome.score).toBe(90); // two warnings, deduction model
  });

  it("errors on entries that 404, are noindexed, or are robots-disallowed", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: goodBody },
          { url: "https://example.com/gone", status: 404, ok: false, body: goodBody },
          {
            url: "https://example.com/hidden",
            body: `<html lang="en"><head><title>t</title><meta name="robots" content="noindex"></head><body></body></html>`,
          },
          { url: "https://example.com/private/page", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml([
              "https://example.com/",
              "https://example.com/gone",
              "https://example.com/hidden",
              "https://example.com/private/page",
            ]),
          },
          [ROBOTS]: {
            status: 200,
            body: `User-agent: *\nDisallow: /private\n\nSitemap: ${SITEMAP}\n`,
          },
        },
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    const messages = errors.map((finding) => finding.message).join(" ");
    expect(messages).toContain("404");
    expect(messages).toContain("noindex");
    expect(messages).toContain("disallow");
    expect(errors.map((finding) => finding.url)).toEqual([
      "https://example.com/gone",
      "https://example.com/hidden",
      "https://example.com/private/page",
    ]);
  });

  it("warns on redirecting and cross-origin entries and pages missing from the sitemap", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/old",
            finalUrl: "https://example.com/new",
            redirected: true,
            body: goodBody,
          },
          { url: "https://example.com/new", body: goodBody },
          { url: "https://example.com/orphan", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/old", "https://elsewhere.invalid/x"]),
          },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
      ),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    const messages = warnings.map((finding) => finding.message).join(" ");
    expect(messages).toContain("redirect");
    expect(messages).toContain("cross-origin");
    const missing = warnings.filter((finding) =>
      finding.message.includes("missing from the sitemap"),
    );
    expect(missing.map((finding) => finding.url).sort()).toEqual([
      "https://example.com/new",
      "https://example.com/orphan",
    ]);
  });

  it("treats an empty/unparseable 200 sitemap as an error", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: "%%% not xml %%%" },
      }),
    );
    expect(
      outcome.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("no URLs"),
      ),
    ).toBe(true);
  });

  it("escalates a blanket robots block to error in production and warning in ci", async () => {
    const routes = {
      [ROBOTS]: { status: 200, body: "User-agent: *\nDisallow: /\n" },
    };
    const production = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], routes, "production"),
    );
    expect(
      production.findings.some(
        (finding) => finding.severity === "error" && finding.message.includes("blocks"),
      ),
    ).toBe(true);
    const ci = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], routes, "ci"),
    );
    expect(ci.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("warns when robots.txt does not reference an existing sitemap", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/"]) },
        [ROBOTS]: { status: 200, body: "User-agent: *\nDisallow:\n" },
      }),
    );
    expect(
      outcome.findings.some(
        (finding) => finding.severity === "warning" && finding.message.includes("reference"),
      ),
    ).toBe(true);
  });

  it("skips entry validation for un-stored entries when the crawl was capped", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: goodBody }],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/", "https://example.com/beyond-cap"]),
          },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
        "production",
        { capped: true },
      ),
    );
    expect(outcome.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  // The following cases exercise branches not covered by the brief's core scenarios above
  // (child-sitemap merging, network failures, malformed entries, canonical mismatches, and
  // the >20-missing aggregation) so the repo's coverage gate stays green.

  const sitemapIndexXml = (locs: string[]) =>
    `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
      .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
      .join("")}</sitemapindex>`;

  const CHILD_SITEMAP = "https://example.com/sitemap-pages.xml";

  it("merges entries from a same-origin child sitemap and ignores a cross-origin one", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          { url: "https://example.com/", body: goodBody },
          { url: "https://example.com/child-page", body: goodBody },
        ],
        {
          [SITEMAP]: {
            status: 200,
            body: sitemapIndexXml([CHILD_SITEMAP, "https://elsewhere.invalid/child.xml"]),
          },
          [CHILD_SITEMAP]: {
            status: 200,
            body: sitemapXml(["https://example.com/", "https://example.com/child-page"]),
          },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
      ),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("tolerates an unreachable child sitemap", async () => {
    const throwingFetch = (url: string): Promise<FetchResult> => {
      if (url === CHILD_SITEMAP) return Promise.reject(new Error("network down"));
      return routesFetch({
        [SITEMAP]: { status: 200, body: sitemapIndexXml([CHILD_SITEMAP]) },
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      })(url);
    };
    const outcome = await sitemapRobotsCheck.run({
      ...contextFor([{ url: "https://example.com/", body: goodBody }], {}),
      fetch: throwingFetch,
    });
    expect(outcome.findings.some((finding) => finding.severity === "error")).toBe(false);
  });

  it("warns when robots.txt and sitemap.xml both fail to fetch (network error, not just 404)", async () => {
    const throwingFetch = (): Promise<FetchResult> => Promise.reject(new Error("boom"));
    const outcome = await sitemapRobotsCheck.run({
      ...contextFor([{ url: "https://example.com/", body: goodBody }], {}),
      fetch: throwingFetch,
    });
    const messages = outcome.findings.map((finding) => finding.message).join(" ");
    expect(messages).toContain("robots.txt could not be fetched");
    expect(messages).toContain("sitemap.xml is missing");
  });

  it("errors on a malformed sitemap entry and one that was never crawled (not capped)", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: {
          status: 200,
          body: sitemapXml([
            "https://example.com/",
            "not a valid url",
            "https://example.com/never-crawled",
          ]),
        },
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      }),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    const messages = errors.map((finding) => finding.message).join(" ");
    expect(messages).toContain("invalid URL");
    expect(messages).toContain("could not be fetched during the crawl");
  });

  it("warns when a sitemap entry's canonical points elsewhere", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/dup",
            body: `<html lang="en"><head><title>t</title><link rel="canonical" href="https://example.com/primary"></head><body></body></html>`,
          },
        ],
        {
          [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/dup"]) },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
      ),
    );
    expect(
      outcome.findings.some(
        (finding) => finding.severity === "warning" && finding.message.includes("canonical"),
      ),
    ).toBe(true);
  });

  it("aggregates more than 20 missing-from-sitemap pages into a single warning", async () => {
    const extraPages = Array.from({ length: 25 }, (_unused, index) => ({
      url: `https://example.com/page-${String(index)}`,
      body: goodBody,
    }));
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }, ...extraPages], {
        [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/"]) },
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      }),
    );
    expect(
      outcome.findings.some((finding) => finding.message.includes("more indexable pages")),
    ).toBe(true);
  });
});
