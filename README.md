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
`functionality.crawl-coverage` warning.

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
