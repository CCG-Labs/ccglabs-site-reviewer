import { describe, expect, it } from "vitest";
import { sitemapRobotsCheck } from "../src/checks/seo/sitemap-robots.js";
import { parseRobotsTxt } from "../src/crawl/robots.js";
import { builtinChecks } from "../src/engine/registry.js";
import { BodySizeCapError } from "../src/fetch/fetcher.js";
import type { CheckContext, Environment, FetchResult, RobotsFetchResult } from "../src/types.js";
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

const ROBOTS = "https://example.com/robots.txt";
const SITEMAP = "https://example.com/sitemap.xml";

// Mirrors what crawlSite() actually does: fetch robots.txt once and hand the result to
// PageStore#robots() (see src/crawl/crawler.ts). Since the check no longer fetches robots.txt
// itself, tests derive the same RobotsFetchResult from `routes` here instead — an unstubbed
// robots.txt route resolves to the same 404-default routesFetch() gives every other URL.
const robotsResultFor = (
  routes: Record<string, { status: number; body?: string }>,
): RobotsFetchResult => {
  const route = routes[ROBOTS];
  const status = route?.status ?? 404;
  return { status, parsed: status === 200 ? parseRobotsTxt(route?.body ?? "") : undefined };
};

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  routes: Record<string, { status: number; body?: string }>,
  environment: Environment = "production",
  stats: Parameters<typeof fixturePageStore>[1] = {},
  robotsOverride: Partial<RobotsFetchResult> = {},
): CheckContext => ({
  baseUrl: "https://example.com",
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    browserSampleSize: 5,
    requestHeaders: {},
    checks: {},
    customChecks: [],
  },
  pages: fixturePageStore(pages, stats, { ...robotsResultFor(routes), ...robotsOverride }),
  fetch: routesFetch(routes),
  logger: { debug: () => undefined },
});

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

  it("fetches child sitemaps concurrently, not one at a time", async () => {
    // Regression test for unbounded worst-case latency: 5 children each with an artificial
    // delay used to previously cost 5x that delay in total (strictly sequential fetching);
    // fetching them concurrently should cost roughly 1x regardless of how many there are.
    const DELAY_MS = 60;
    const children = Array.from(
      { length: 5 },
      (_unused, index) => `https://example.com/child-${String(index)}.xml`,
    );
    const delayedFetch = (url: string): Promise<FetchResult> => {
      const respond = () =>
        routesFetch({
          [SITEMAP]: { status: 200, body: sitemapIndexXml(children) },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
          ...Object.fromEntries(
            children.map((child) => [child, { status: 200, body: sitemapXml([]) }]),
          ),
        })(url);
      if (children.includes(url)) {
        return new Promise((resolvePromise) => {
          setTimeout(() => {
            resolvePromise(respond());
          }, DELAY_MS);
        });
      }
      return respond();
    };
    const started = Date.now();
    await sitemapRobotsCheck.run({
      ...contextFor([{ url: "https://example.com/", body: goodBody }], {}),
      fetch: delayedFetch,
    });
    const elapsedMs = Date.now() - started;
    // Sequential would take >= 5 * DELAY_MS (300ms); concurrent should stay well under that
    // even with scheduling overhead. Generous margin to avoid CI flakiness.
    expect(elapsedMs).toBeLessThan(3 * DELAY_MS);
  });

  it("merges entries from a same-origin child sitemap and warns (not errors) about a cross-origin one", async () => {
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
    // The good child's entries are still fully validated (no errors) — but a sitemap index
    // that references a foreign-origin child is flagged, since that child never gets checked.
    // Crucially: this must NOT be treated as a "failed" child (that's a same-origin fetch
    // that actually failed) — a cross-origin child is a different, lower-severity problem.
    expect(outcome.findings.every((finding) => finding.severity === "warning")).toBe(true);
    expect(
      outcome.findings.some(
        (finding) =>
          finding.message.includes("1 child sitemap(s) on a different origin") &&
          finding.message.includes("never fetched"),
      ),
    ).toBe(true);
    expect(
      outcome.findings.some((finding) => finding.message.includes("could not be fetched")),
    ).toBe(false);
  });

  it("does NOT error when every child sitemap is simply on a different origin (a real multi-subdomain pattern)", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: {
          status: 200,
          body: sitemapIndexXml([
            "https://blog.elsewhere.invalid/sitemap.xml",
            "https://shop.elsewhere.invalid/sitemap.xml",
          ]),
        },
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      }),
    );
    // Cross-origin children are never attempted, so they must not be conflated with children
    // that were attempted and genuinely failed — this used to fire the "none could be fetched"
    // blocking error for a legitimate architecture (e.g. per-subdomain sitemaps).
    expect(outcome.findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(
      outcome.findings.some(
        (finding) =>
          finding.message.includes("2 child sitemap(s) on a different origin") &&
          finding.severity === "warning",
      ),
    ).toBe(true);
  });

  it("errors when every child sitemap in an index is unreachable (previously silent)", async () => {
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
    // A sitemap index pointing at nothing but dead children is as bad as no sitemap at all.
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors.some((finding) => finding.message.includes("none could be fetched"))).toBe(true);
  });

  it("flags declared child sitemaps left unchecked when a large earlier child hits the entry cap", async () => {
    // Regression test: previously, a large valid child sitemap listed before broken ones
    // would push totalChildSitemaps to the full declared count without those later children
    // ever being visited, silently passing over them (0 failed of a falsely-inflated total).
    const SECOND_CHILD = "https://example.com/sitemap-more.xml";
    const manyUrls = Array.from(
      { length: 2_001 },
      (_unused, index) => `https://example.com/p${String(index)}`,
    );
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: goodBody }],
        {
          [SITEMAP]: { status: 200, body: sitemapIndexXml([CHILD_SITEMAP, SECOND_CHILD]) },
          [CHILD_SITEMAP]: { status: 200, body: sitemapXml(manyUrls) },
          // SECOND_CHILD deliberately left unstubbed -> would 404 if ever fetched, but the
          // entry cap should stop the loop before it's visited at all.
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
        "production",
        // capped: true — this test is about child-sitemap bookkeeping, not per-entry crawl
        // validation, so skip "could not be fetched during the crawl" noise for the 2,000
        // page URLs this synthetic sitemap lists that were never actually crawled.
        { capped: true },
      ),
    );
    expect(outcome.findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(
      outcome.findings.some(
        (finding) =>
          finding.severity === "warning" &&
          finding.message.includes("1 more child sitemap(s)") &&
          finding.message.includes("weren't checked"),
      ),
    ).toBe(true);
  }, 30_000);

  it("counts a 404'd child sitemap (not just a network error) as unreachable", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: sitemapIndexXml([CHILD_SITEMAP]) },
        // CHILD_SITEMAP deliberately left unstubbed -> 404 (not a thrown network error)
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      }),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors.some((finding) => finding.message.includes("none could be fetched"))).toBe(true);
  });

  it("checks every sitemap robots.txt declares, not just the first", async () => {
    const SECOND_SITEMAP = "https://example.com/sitemap-blog.xml";
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/"]) },
        // SECOND_SITEMAP deliberately left unstubbed -> 404
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\nSitemap: ${SECOND_SITEMAP}\n` },
      }),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(
      warnings.some(
        (finding) =>
          finding.url === SECOND_SITEMAP && finding.message.includes("could not be fetched"),
      ),
    ).toBe(true);
    // the first, valid sitemap's entries are still fully validated — no errors, no missing pages
    expect(outcome.findings.some((finding) => finding.severity === "error")).toBe(false);
  });

  it("passes cleanly when robots.txt declares a non-default sitemap path (the one-day-website scenario)", async () => {
    const NON_DEFAULT = "https://example.com/sitemap-index.xml";
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [NON_DEFAULT]: { status: 200, body: sitemapXml(["https://example.com/"]) },
        // /sitemap.xml deliberately left unstubbed -> 404; must not be consulted at all
        [ROBOTS]: { status: 200, body: `Sitemap: ${NON_DEFAULT}\n` },
      }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("gives an actionable message when a sitemap trips the fetcher's response-size cap", async () => {
    // The shared fetcher enforces a 5MB body cap well under the sitemaps.org 50MB spec
    // limit, so a dedicated "over 50MB" check could never fire against a real response —
    // this instead exercises the actual failure path a too-large sitemap takes.
    const sizeCappedFetch = (url: string): Promise<FetchResult> => {
      if (url === SITEMAP)
        return Promise.reject(
          new BodySizeCapError(`Response body exceeded 5242880 bytes: ${SITEMAP}`),
        );
      return routesFetch({ [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` } })(url);
    };
    const outcome = await sitemapRobotsCheck.run({
      ...contextFor([{ url: "https://example.com/", body: goodBody }], {}),
      fetch: sizeCappedFetch,
    });
    expect(
      outcome.findings.some(
        (finding) =>
          finding.severity === "warning" && finding.message.includes("too large to fetch"),
      ),
    ).toBe(true);
  });

  it("warns when a sitemap file exceeds the sitemaps.org 50,000-URL-per-file limit", async () => {
    const manyUrls = Array.from(
      { length: 50_001 },
      (_unused, index) => `https://example.com/p${String(index)}`,
    );
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }], {
        [SITEMAP]: { status: 200, body: sitemapXml(manyUrls) },
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      }),
    );
    expect(
      outcome.findings.some(
        (finding) => finding.severity === "warning" && finding.message.includes("50,000 URLs"),
      ),
    ).toBe(true);
  }, 30_000);

  it("warns when robots.txt and sitemap.xml both fail to fetch (network error, not just 404)", async () => {
    // Simulates the crawler's own robots.txt fetch throwing (see crawlSite in crawler.ts,
    // which swallows the error and leaves status/parsed both undefined) — the check now reads
    // that pre-fetched result instead of fetching robots.txt itself. sitemap.xml is still
    // fetched directly by the check, so leaving it unstubbed exercises its own 404 path.
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [{ url: "https://example.com/", body: goodBody }],
        {},
        "production",
        {},
        {
          parsed: undefined,
          status: undefined,
        },
      ),
    );
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

  it("damps the missing-from-sitemap class's scoring impact so it can't alone drive the score to 0", async () => {
    const extraPages = Array.from({ length: 30 }, (_unused, index) => ({
      url: `https://example.com/page-${String(index)}`,
      body: goodBody,
    }));
    const outcome = await sitemapRobotsCheck.run(
      contextFor([{ url: "https://example.com/", body: goodBody }, ...extraPages], {
        [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/"]) },
        [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
      }),
    );
    expect(outcome.findings).toHaveLength(21);
    expect(outcome.findings.every((finding) => finding.severity === "warning")).toBe(true);
    // 21 missing-class warnings would cost 105 points uncapped; damped to 4
    // warning-units (20 points) so this one soft condition can't zero the score.
    expect(outcome.score).toBe(80);
  });

  it("catches X-Robots-Tag noindex on a non-HTML sitemap entry (e.g. a PDF)", async () => {
    const outcome = await sitemapRobotsCheck.run(
      contextFor(
        [
          {
            url: "https://example.com/doc.pdf",
            body: "",
            headers: { "content-type": "application/pdf", "x-robots-tag": "noindex" },
          },
        ],
        {
          [SITEMAP]: { status: 200, body: sitemapXml(["https://example.com/doc.pdf"]) },
          [ROBOTS]: { status: 200, body: `Sitemap: ${SITEMAP}\n` },
        },
      ),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors.some((finding) => finding.message.includes("noindex"))).toBe(true);
  });
});
