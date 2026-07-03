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
