# CCG Labs Site Reviewer — Design

**Date:** 2026-07-03
**Status:** Draft — pending Brian's review
**Source research:** `~/Downloads/website-launch-checklist-report(1).md` (25-check launch checklist)

## Decisions made with Brian

- **Input model: URL-only.** Every run targets a URL (dev server, CI preview, or production) and crawls it. No filesystem/`dist/` mode in v1; it can be added later as a second input adapter if crawling proves slow.

## Assumptions made while Brian was AFK (flag anything wrong)

1. **Fetch-tier checks first.** Build the framework plus all checks that need only HTTP + HTML parsing before any Playwright/Lighthouse checks. Browser deps arrive later as optional peer dependencies so base install stays lean.
2. **Package:** `@ccglabs/site-reviewer`, bin `site-review`. TypeScript strict, ESM, Node ≥ 20.
3. **Stack:** `tsup` build, `vitest` tests, `commander` CLI, `cheerio` HTML parsing, native `fetch` (undici) for HTTP.
4. **Environments named `local | ci | production`.**
5. **Pass/fail model:** run fails if any *blocking* check fails, or overall score < threshold (default 80). Everything configurable.

## Goals

- One tool, three environments: local dev, CI, live production — with per-check environment applicability (checks that don't apply are reported as `skipped` with a reason, never silently omitted).
- Canonical machine-readable JSON report: pass/fail grade, overall score, per-category scores, per-check findings, recommendations for every failure, debug output.
- Scriptable two ways: a CLI, and a typed public API (`runReview()`) supporting custom checks and customized runs.
- Usable incrementally — each PR ships a working tool with more checks, so it can validate a real site from PR 2 onward.

## Non-goals (v1)

- Filesystem/`dist/` analysis mode.
- WordPress-specific checks (WPScan etc.).
- Repo-level checks (`npm audit`, gitleaks) — the tool audits a *site*, not a codebase.
- HTML dashboard / PR-comment renderer (JSON output makes these easy add-ons later).
- Claiming full WCAG compliance — the report will carry a generated "manual sign-off" checklist for what automation can't verify.

## Architecture

**Approach chosen: check-registry engine with a shared crawl context.** (Alternatives considered: (a) three monolithic scripts per environment — fast to write, not extensible, no unified scoring; (b) orchestrator wrapping external CLIs (lhci, pa11y-ci, linkinator) — maximum reuse but heavy install, poor control over unified JSON, version drift. Chosen approach uses libraries — axe-core, lighthouse-as-a-library — *inside* checks where they earn their weight, custom code elsewhere, per the report's "wrap best-of-breed, spend custom code where nothing good exists" guidance.)

```
CLI (commander)  ──┐
                   ├──▶ runReview(options) ──▶ Engine
Public API  ───────┘                            │
                                                ├─ ConfigResolver (defaults ◀ config file ◀ API opts ◀ CLI flags)
                                                ├─ Crawler ──▶ PageStore (shared fetch cache)
                                                ├─ CheckRegistry (built-ins + config.customChecks)
                                                ├─ Runner (env filter → parallel execution → per-check timeout)
                                                └─ Scorer ──▶ ReviewReport (JSON) ──▶ Reporters (json | console)
```

### Components

**Crawler / PageStore.** Seeds from the base URL plus `sitemap.xml` when present; same-origin BFS with configurable `maxPages` (default 200), concurrency limit, timeout, retry-once on network error. Stores per-page: final URL, status, headers, HTML body, redirect chain, fetch timing. All checks read from the PageStore — one fetch per page for the whole run. Checks may make *additional* targeted requests (e.g., HEAD an `og:image`, probe `/.env`) through a shared rate-limited fetch helper.

**Check interface** (the extension point, public):

```ts
interface Check {
  id: string;                     // "seo.meta-tags"
  category: CategoryId;           // "functionality" | "performance" | "accessibility" | "seo" | "security" | "content" | "operations"
  description: string;
  environments: Environment[];    // where it applies; else auto-skip
  blocking: boolean;              // failure fails the run regardless of score
  weight: number;                 // relative weight within its category (default 1)
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

interface CheckContext {
  baseUrl: string;
  environment: Environment;
  pages: PageStore;
  config: ResolvedConfig;         // incl. per-check options
  fetch: RateLimitedFetch;
  logger: Logger;                 // feeds report debug output
}

interface CheckOutcome {
  score: number;                  // 0–100
  findings: Finding[];            // empty ⇒ pass
}

interface Finding {
  severity: "error" | "warning" | "info";
  message: string;                // what is wrong
  recommendation: string;         // how to fix it — required for errors
  url?: string;                   // page it occurred on
  details?: unknown;              // structured debug payload
}
```

**Scoring.** Check status derives from findings: any `error` ⇒ `fail`, only `warning`s ⇒ `warn`, none ⇒ `pass`. Category score = weight-averaged check scores (skipped/errored checks excluded from the average). Overall score = average of category scores over categories that ran. Grade: `pass` iff no blocking check failed AND overall ≥ `failThreshold` (default 80).

**Report JSON** (canonical output; console reporter renders from the same object):

```jsonc
{
  "reportVersion": 1,
  "tool": { "name": "@ccglabs/site-reviewer", "version": "0.3.0" },
  "target": "https://example.com",
  "environment": "production",
  "startedAt": "…", "durationMs": 41230,
  "crawl": { "pagesDiscovered": 43, "pagesScanned": 43, "capped": false },
  "grade": "fail",
  "score": 74,
  "categories": [
    { "id": "seo", "score": 61, "checks": [
      { "id": "seo.meta-tags", "status": "fail", "score": 55, "blocking": true,
        "findings": [ { "severity": "error", "url": "https://example.com/about",
          "message": "Duplicate <title> shared with /team",
          "recommendation": "Give each page a unique title under 60 characters." } ],
        "debug": { "pagesChecked": 43 } }
    ] }
  ],
  "skipped": [ { "id": "security.tls", "reason": "not applicable in environment \"local\"" } ],
  "manualChecklist": [ "Proofread copy against approved deck", "Real-device iOS/Android pass", "…" ]
}
```

**CLI.**

```
site-review <url> [--env local|ci|production] [--config <path>]
            [--checks <ids…>] [--skip <ids…>] [--max-pages N]
            [--fail-threshold N] [--output <file>] [--format json|console|both]
```

Exit code 0 on pass, 1 on fail, 2 on tool error. Default format `both` (console summary + JSON to stdout or `--output`).

**Public API.**

```ts
import { runReview, defineConfig, type Check, type ReviewReport } from "@ccglabs/site-reviewer";
const report: ReviewReport = await runReview({ url, environment: "ci", config });
```

`defineConfig()` for typed config files; `config.customChecks: Check[]` registers user checks alongside built-ins.

**Config file.** `site-review.config.{ts,js,json}` discovered from CWD (loaded via `jiti` for TS). Shape: `environment` defaults, `maxPages`, `failThreshold`, `requestHeaders` (auth for staging), per-check `checks: { "<id>": false | { blocking?, weight?, options? } }`, per-environment overrides, ignore lists (URL patterns, placeholder allowlist, known-noisy third parties). Precedence: defaults < config file < API options < CLI flags.

### Environment applicability (examples)

| Check | local | ci | production |
|---|---|---|---|
| TLS cert / HTTPS redirect | skip | skip (http previews) | run |
| Security headers | skip | run | run |
| `noindex` guard | skip | warn-only | fail on noindex |
| External links | skip | skip | run (non-blocking) |
| Sensitive-file probes | skip | run | run |
| Meta/links/sitemap/schema/OG/placeholders | run | run | run |

Defaults live on each check; config can override per environment.

### Error handling

- A check that throws is reported with status `error` (excluded from scoring, listed in report, never kills the run).
- Per-check timeout (default 60 s) and per-page fetch timeout (default 15 s, one retry).
- Unreachable base URL ⇒ tool error, exit 2, minimal JSON error report.
- Crawl cap reached ⇒ `crawl.capped: true` plus a warning finding, so partial coverage is never mistaken for full.

### Testing strategy

- Unit tests per check against HTML fixtures via a fixture-backed PageStore (no network).
- Integration tests: vitest boots a local static server serving fixture sites ("clean site" and "broken site" with known seeded defects); assert report JSON end-to-end, including skip behavior per environment.
- The report JSON schema is exported (zod) and validated in tests — the schema is the public contract.
- Browser-tier checks (later PRs) get a small smoke suite tagged to run separately in CI.

## Implementation roadmap — one PR per feature

Each PR leaves the tool releasable and usable against a real site.

| PR | Deliverable |
|---|---|
| 1 | **Scaffold**: repo hygiene (CCG Labs create-repo baseline when pushed to GitHub), TS strict + ESM, tsup, vitest, lint, CI workflow, package skeleton |
| 2 | **Core engine**: types, config resolution, registry, runner, scorer, report schema (zod), JSON + console reporters, CLI, API — with one trivial built-in check (`functionality.reachable`: base URL returns 200) |
| 3 | **Crawler + PageStore**: sitemap seeding, BFS, caching, rate limiting |
| 4 | **`seo.meta-tags`**: title/description presence + length + site-wide uniqueness, canonical, single h1, `lang`, noindex guard (env-aware) |
| 5 | **`functionality.links`**: internal links + anchors + assets; external links production-only, non-blocking |
| 6 | **`seo.sitemap-robots`**: sitemap validity, entries return 200/canonical/not-noindexed; robots.txt sanity, sitemap reference |
| 7 | **`security.headers` + `security.tls`**: OWASP header set (incl. on 404 responses), deprecated/leaky header detection; cert validity/expiry, http→https redirect, mixed-content scan |
| 8 | **`seo.structured-data`**: JSON-LD parse + required-property validation per type |
| 9 | **`seo.social-meta`**: OG/Twitter tags, `og:image` resolves + dimensions |
| 10 | **`content.placeholders` + `content.images`**: lorem ipsum/`{{`/`undefined`/`NaN` in text content; `<img>` alt/width/height/lazy hygiene, oversized image detection |
| 11 | **`functionality.error-pages` + `security.sensitive-files`**: real-404 (no soft-200) + branded 404 marker; probes for `/.env`, `/.git/HEAD`, backups |
| 12 | **`performance.lighthouse`** (browser tier begins, optional peer dep): CWV budgets, category minimums, median-of-3 |
| 13 | **`accessibility.axe`**: axe-core via Playwright across crawled pages, fail on serious/critical |
| 14 | **`functionality.console-errors`**: JS exceptions + failed requests per page (Playwright) |
| 15 | **`operations.analytics`**: snippet presence/uniqueness, correct property ID per environment, optional request interception |

Later candidates (post-v1 backlog): HTML validity (html-validate), redirect-map validation, visual regression, keyboard-nav asserts, consent gating, cross-browser projects, DNS/expiry monitoring.

## Codebase quality & security attestation

The tool must be able to attest to its own quality — it's a trust product. Established in PR 1 (scaffold), enforced on every PR thereafter.

### Merge-blocking CI gates (every PR)

- **Typecheck**: `tsc --noEmit`, strict mode, no `any` escapes (`@typescript-eslint/no-explicit-any` as error).
- **Lint + format**: ESLint (typescript-eslint strict + security plugin) and Prettier — CI fails on any diff.
- **Tests**: vitest with coverage gate — v8 coverage ≥ 90% lines/branches on `src/` (ratcheted, never lowered; the engine and every check are TDD'd per superpowers:test-driven-development).
- **Build**: tsup build + `publint` + `arethetypeswrong` so the published package surface (ESM exports, types) is verified, not assumed.
- **Report-schema contract test**: the exported zod schema validates all fixture reports; any schema change requires a `reportVersion` bump enforced by test.
- **Secret scanning**: gitleaks action.
- **Dependency audit**: `npm audit --audit-level=high` fails the build.
- Branch protection on `main`: PRs only, required status checks, no force push (applied via the CCG Labs create-repo baseline when the repo is pushed to GitHub).

### Supply chain

- **Minimal dependency policy**: each new runtime dependency is vetted with the eval-dependency process before adoption; prefer zero-dep or well-audited packages (cheerio, zod, commander are the expected core). Browser tier (playwright, lighthouse) ships as optional peer deps so consumers who never run browser checks never install them.
- Committed lockfile; `npm ci` only in CI. Dependabot security updates + weekly grouped version PRs.
- **CodeQL** analysis on PRs and a weekly schedule.
- **Publishing**: releases only from a GitHub Actions release workflow with npm **provenance attestation** (`npm publish --provenance` via OIDC — publicly verifiable build-to-package link); no local publishes; npm account 2FA; tags signed.
- `SECURITY.md` with disclosure policy; OpenSSF Scorecard badge once public.

### Runtime security posture (the tool touches untrusted input)

The tool fetches and parses arbitrary remote HTML — treat every byte as hostile:

- **No dynamic evaluation** of fetched content, ever (JSON-LD is `JSON.parse`d in try/catch, never evaluated); no `eval`/`new Function`/`child_process` in runtime code (enforced by ESLint rules).
- **SSRF discipline**: the crawler only follows same-origin links from the user-supplied base URL; redirects off-origin terminate the chain (recorded, not followed); no requests to link-derived hosts except explicit check targets (e.g., `og:image` HEAD) which are capped and rate-limited.
- **Resource caps**: max response size per page (default 5 MB), max pages, per-request timeout — a malicious/broken site can't OOM or hang a CI run.
- **Secret hygiene in output**: `requestHeaders` (staging auth) are redacted from the JSON report, debug payloads, and logs.
- Every security-relevant PR (crawler, fetch helper, probes) gets a security-review pass before merge.

### Review process per PR

Each PR runs /code-review before merge; PRs touching the crawler/fetch layer or probe checks additionally get /security-review. The full suite (typecheck, lint, tests, build, audit, gitleaks, CodeQL) is required-green before merge.

## Manual sign-off (always in report)

Content accuracy/tone proofread, real-device spot check, screen-reader pass, legal adequacy of policies, email deliverability, Search Console submission, rollback plan. The tool reports "automated scan passed," never "site is accessible/launch-ready."
