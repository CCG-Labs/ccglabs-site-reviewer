# @ccglabs/site-reviewer

Automated website review: crawl a URL, run environment-aware quality
checks (SEO, security, performance, accessibility, content), and emit a
scored, machine-readable JSON report with a pass/fail grade and
recommendations for every failure.

Status: under active development. See
`docs/superpowers/specs/2026-07-03-site-reviewer-design.md` for the
design and roadmap.

## CLI

```bash
npx site-review https://example.com --env production
site-review http://localhost:4321 --env local --format console
site-review https://preview.example.com --env ci --output report.json
```

Exit codes: `0` pass, `1` fail, `2` tool error.

## API

```ts
import { runReview } from "@ccglabs/site-reviewer";

const report = await runReview({ url: "https://example.com", environment: "ci" });
if (report.grade === "fail") {
  for (const category of report.categories)
    for (const check of category.checks)
      for (const finding of check.findings)
        console.log(finding.message, "→", finding.recommendation);
}
```

## Crawling

Every run crawls the target site once — same-origin BFS seeded from the base
URL and `sitemap.xml` — up to `maxPages` (default 200, `--max-pages` on the
CLI). Checks read the shared crawl results instead of re-fetching pages. The
report's `crawl` block (`pagesDiscovered` / `pagesScanned` / `capped`) tells
you whether coverage was complete; a capped crawl also surfaces as a
`functionality.crawl-coverage` warning. Crawl results are held in memory for
the run; worst case is roughly `maxPages` × 5 MB (the per-response body cap)
for HTML-heavy sites — lower `maxPages` for constrained environments. The
crawler itself deliberately ignores robots.txt — it is the site owner's own
tool and needs to see everything — while the `seo.sitemap-robots` check
separately reports what search engines will and won't be allowed to crawl.

## Checks

| id                             | what it verifies                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `functionality.reachable`      | the base URL responds successfully (no 4xx/5xx, no unfollowed off-origin redirect)                                                                           |
| `functionality.crawl-coverage` | the crawl covered the site without hitting `maxPages`                                                                                                        |
| `functionality.links`          | internal links, anchors, and assets resolve (blocking); external links validated in production only (warnings, capped at 50)                                 |
| `seo.meta-tags`                | one good title/description/canonical/h1/lang per page; titles unique site-wide; no stray `noindex` (error in production, warning in ci)                      |
| `seo.sitemap-robots`           | sitemap.xml exists and lists only live, canonical, indexable, robots-allowed URLs; crawled pages appear in it; robots.txt is sane and references the sitemap |
| `seo.structured-data`          | JSON-LD parses, declares @type, and carries required properties per schema.org type; flags conflicting singletons and site-wide absence                      |
| `seo.social-meta`              | Open Graph/Twitter tags present per page; og:image is absolute, resolves, and is an image (external images probed in production only)                        |
| `security.headers`             | OWASP security headers present with sane values, including on error responses (error in production, warning in ci)                                           |
| `security.tls`                 | https enforced, certificate valid and >30 days from expiry, no mixed content (production only)                                                               |

Per-check options go under `checks` in the config file:

```ts
export default defineConfig({
  checks: {
    "seo.meta-tags": {
      options: { noindexAllow: ["https://example.com/internal-tool"] },
    },
    "functionality.links": {
      options: { ignore: ["analytics.example", "/known-flaky-asset.png"] },
    },
  },
});
```

Internal asset probing caps at 500 unique URLs per run, external at 50; overflow is logged in debug output.

## Configuration

`site-review.config.ts` (or `.js` / `.json`) in the working directory:

```ts
import { defineConfig } from "@ccglabs/site-reviewer";

export default defineConfig({
  failThreshold: 85,
  maxPages: 100,
  requestHeaders: { authorization: `Bearer ${process.env.STAGING_TOKEN ?? ""}` },
  checks: { "functionality.reachable": { blocking: true } },
  environments: { production: { failThreshold: 90 } },
});
```
