# Site Reviewer PR 7 (security.headers + security.tls) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the security category: `security.headers` (OWASP response-header validation, including on 404 responses) and `security.tls` (certificate validity/expiry, http→https redirect, mixed-content scan) — plus the fetcher-level cross-origin auth-header stripping ride-along.

**Architecture:** `security.headers` reads the base page's response headers from the PageStore, probes one guaranteed-404 path via `ctx.fetch`, and evaluates both against an OWASP severity table (pure `analyzeHeaders` function). `security.tls` observes the http→https redirect through the existing fetcher result (`redirected`/`finalUrl`), scans stored HTML for `http://` resource references (mixed content), and inspects the certificate via `node:tls` (a small `inspectCertificate` probe; expiry logic is a pure function tested with injected dates). Both use the deduction scoring model (`max(0, 100 − 20e − 5w)`), matching `seo.sitemap-robots`. The ride-along makes `createFetcher` send configured `requestHeaders` only to trusted origins.

**Tech Stack:** node:tls (builtin — no new dependency), cheerio, PageStore, committed long-lived self-signed test certificates (gitleaks-allowlisted).

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`. `node:tls` is a builtin. Report schema UNCHANGED.
- No `eval` / `new Function` / `child_process` in `src/` OR tests (ESLint bans it repo-wide) — test certificates are pre-generated and committed as fixtures, never generated at runtime.
- Coverage 90% gates untouched. TypeScript strict; no `any`.
- **Ride-along (security)**: `FetcherOptions` gains `trustedOrigins?: ReadonlySet<string>`. When set, configured `requestHeaders` are attached ONLY to requests (including redirect hops) whose target origin is in the set; other requests are sent without them. When unset, behavior is unchanged (headers always sent — backward compatible). `runReview` passes `allowedOriginsFor(new URL(options.url))`. This closes the "staging auth headers reach third-party hosts on external-link probes" gap.
- `security.headers`: id `security.headers`, category `security`, `blocking: true`, weight 1, environments `["ci", "production"]` (local dev servers don't set host-layer headers — per the spec's applicability table).
  - Evaluated on the base page's stored response headers AND on a probe of `/__site-review-404-probe__` (via `ctx.fetch`).
  - Severity table (on the base response):
    - `strict-transport-security` missing while the final URL is https → **error**; present with `max-age` < 15552000 → **warning**.
    - `x-content-type-options` missing or ≠ `nosniff` → **error**.
    - `content-security-policy` missing → **warning** (no policy parsing in v1).
    - Clickjacking: no `x-frame-options` AND no CSP `frame-ancestors` directive → **warning** (only when CSP or XFO absent — if CSP contains `frame-ancestors`, satisfied).
    - `referrer-policy` missing → **warning**; `permissions-policy` missing → **warning**.
    - Deprecated present (`x-xss-protection`, `public-key-pins`) → **warning** each.
    - Leaky: `x-powered-by` present → **warning**; `server` value containing a version number (matches `/\d/` after a `/`) → **warning**.
  - 404-response parity: required headers present on the base response but absent on the 404 response → ONE aggregated **warning** listing them. 404 probe network failure → debug log, no finding.
- `security.tls`: id `security.tls`, category `security`, `blocking: true`, weight 1, environments `["production"]` only.
  - http→https: when `ctx.baseUrl` is `http:`, the stored base page's `finalUrl` must be `https:` (the fetcher follows upgrade redirects) → otherwise **error** ("served over http without redirecting to https"). When base is already https, this sub-check passes trivially.
  - Certificate (via `inspectCertificate(host, port, { ca?, timeoutMs? })` using `node:tls`, `rejectUnauthorized: true`, `servername` set for SNI): handshake/validation failure → **error** ("certificate invalid: <reason>"); expiry: `validTo` < now → **error**; < 30 days away → **warning** (pure function `certExpiryFindings(validTo: Date, now: Date)`). Probe the https host of the final base URL. Connection timeout (default 10s) → **warning** ("could not inspect certificate"), not error (network flakiness ≠ bad cert).
  - Mixed content: every stored 2xx HTML page whose `finalUrl` is https is scanned (`findMixedContent(html): string[]` — raw `http://` values in `src`, `href` of stylesheet links, `srcset`, and `iframe` src) → one **error** per affected page (message lists up to 3 offending URLs + count).
- Scoring for both checks: `max(0, 100 − 20·errors − 5·warnings)`.
- Test TLS fixtures: pre-generated self-signed cert/key PEMs committed under `tests/fixtures/tls/` (validity ~100 years so tests never age out). `.gitleaks.toml` allowlists that path (test-only material, clearly labeled). The implementer generates them ONCE with openssl in the shell (allowed — it's a build step, not runtime code).
- Conventional commits. Branch: `feat/security-checks` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/fetch/fetcher.ts                    (ride-along) trustedOrigins
src/engine/run-review.ts                (ride-along) pass trusted origins
src/checks/security/headers.ts          analyzeHeaders + securityHeadersCheck
src/checks/security/tls-probe.ts        inspectCertificate (node:tls)
src/checks/security/tls.ts              certExpiryFindings + findMixedContent + securityTlsCheck
src/engine/registry.ts                  register both
tests/fixtures/tls/{cert.pem,key.pem}   committed test-only self-signed pair
.gitleaks.toml                          allowlist for tests/fixtures/tls/
README.md                               checks table rows
```

---

### Task 1: Fetcher trustedOrigins ride-along

**Files:**

- Modify: `src/fetch/fetcher.ts`, `src/engine/run-review.ts`
- Test (modify): `tests/fetcher.test.ts`

**Interfaces:**

- Produces: `FetcherOptions.trustedOrigins?: ReadonlySet<string>` — headers attached only to trusted-origin requests when set; `runReview` builds the fetcher with `trustedOrigins: allowedOriginsFor(new URL(options.url))` (import from `../crawl/crawler.js`).

- [ ] **Step 1: Write the failing tests** — add to `tests/fetcher.test.ts`:

```ts
it("sends configured headers only to trusted origins when trustedOrigins is set", async () => {
  let seenAuth: string | undefined = "unset";
  server = await startServer((req, res) => {
    seenAuth = req.headers["x-staging-token"] as string | undefined;
    res.end("ok");
  });
  const trusted = createFetcher({
    requestHeaders: { "x-staging-token": "s3cret" },
    trustedOrigins: new Set([new URL(server.url).origin]),
  });
  await trusted(server.url);
  expect(seenAuth).toBe("s3cret");

  const untrusted = createFetcher({
    requestHeaders: { "x-staging-token": "s3cret" },
    trustedOrigins: new Set(["https://elsewhere.invalid"]),
  });
  await untrusted(server.url);
  expect(seenAuth).toBeUndefined();
});

it("keeps sending headers on same-origin redirect hops", async () => {
  const seen: Array<string | undefined> = [];
  server = await startServer((req, res) => {
    seen.push(req.headers["x-staging-token"] as string | undefined);
    if (req.url === "/start") {
      res.statusCode = 302;
      res.setHeader("location", "/end");
      res.end();
      return;
    }
    res.end("done");
  });
  const fetcher = createFetcher({
    requestHeaders: { "x-staging-token": "s3cret" },
    trustedOrigins: new Set([new URL(server.url).origin]),
  });
  const result = await fetcher(`${server.url}/start`);
  expect(result.body).toBe("done");
  expect(seen).toEqual(["s3cret", "s3cret"]);
});
```

Run: `npx vitest run tests/fetcher.test.ts` — Expected: FAIL (unknown option / headers always sent).

- [ ] **Step 2: Implement in `src/fetch/fetcher.ts`**

Add to `FetcherOptions`:

```ts
  /**
   * When set, configured requestHeaders are attached only to requests whose
   * target origin is in this set — never to third-party hosts.
   */
  trustedOrigins?: ReadonlySet<string>;
```

Destructure `trustedOrigins` in `createFetcher`. In `attempt()`, compute headers per hop:

```ts
const hopHeaders =
  trustedOrigins === undefined || trustedOrigins.has(new URL(currentUrl).origin)
    ? requestHeaders
    : {};
```

and pass `headers: hopHeaders` to `fetch`.

- [ ] **Step 3: Wire `runReview`** — in `src/engine/run-review.ts`, import `allowedOriginsFor` from `../crawl/crawler.js` and change the fetcher construction to:

```ts
const fetchFn = createFetcher({
  requestHeaders: config.requestHeaders,
  trustedOrigins: allowedOriginsFor(new URL(options.url)),
});
```

Note: `new URL(options.url)` may throw for garbage input — wrap the preflight section accordingly: construct the URL BEFORE the preflight try/catch and let an invalid URL surface as `SiteUnreachableError` (`throw new SiteUnreachableError(\`Cannot reach ${options.url}: invalid URL\`)` from a try/catch around the URL construction).

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/fetcher.test.ts tests/run-review.test.ts` then `npm run format && npm run verify` — Expected: green.

```bash
git add src/fetch/fetcher.ts src/engine/run-review.ts tests/fetcher.test.ts
git commit -m "fix: send configured auth headers only to trusted origins"
```

---

### Task 2: security.headers

**Files:**

- Create: `src/checks/security/headers.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-security-headers.test.ts`

**Interfaces:**

- Consumes: `ctx.pages.get(ctx.baseUrl)` (base page headers), `ctx.fetch` (404 probe).
- Produces: `analyzeHeaders(headers: Record<string, string>, options: { https: boolean }): Finding-shaped items without url` (exported for tests) and `securityHeadersCheck: Check` registered in `builtinChecks`.

Write `src/checks/security/headers.ts`:

```ts
import type { Check, Finding } from "../../types.js";

const PROBE_PATH = "/__site-review-404-probe__";
const HSTS_MIN_MAX_AGE = 15_552_000; // 180 days
const ERROR_COST = 20;
const WARNING_COST = 5;

/** Required headers whose 404-parity we verify. */
const PARITY_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "content-security-policy",
  "referrer-policy",
  "permissions-policy",
];

interface HeaderIssue {
  severity: "error" | "warning";
  message: string;
  recommendation: string;
}

export function analyzeHeaders(
  headers: Record<string, string>,
  options: { https: boolean },
): HeaderIssue[] {
  const issues: HeaderIssue[] = [];
  const get = (name: string): string | undefined => headers[name];

  if (options.https) {
    const hsts = get("strict-transport-security");
    if (hsts === undefined) {
      issues.push({
        severity: "error",
        message: "Strict-Transport-Security header is missing.",
        recommendation: 'Add "Strict-Transport-Security: max-age=63072000; includeSubDomains".',
      });
    } else {
      const maxAge = /max-age=(\d+)/i.exec(hsts);
      if (maxAge === null || Number(maxAge[1]) < HSTS_MIN_MAX_AGE) {
        issues.push({
          severity: "warning",
          message: `Strict-Transport-Security max-age is below ${String(HSTS_MIN_MAX_AGE)} seconds (180 days).`,
          recommendation: "Raise max-age to at least 15552000 (a year is standard: 31536000).",
        });
      }
    }
  }

  if ((get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    issues.push({
      severity: "error",
      message: "X-Content-Type-Options is missing or not set to nosniff.",
      recommendation: 'Add "X-Content-Type-Options: nosniff" to every response.',
    });
  }

  const csp = get("content-security-policy");
  if (csp === undefined) {
    issues.push({
      severity: "warning",
      message: "Content-Security-Policy header is missing.",
      recommendation:
        "Add a CSP — even a minimal frame-ancestors policy blocks clickjacking; a full policy mitigates XSS.",
    });
  }
  const cspHasFrameAncestors = csp !== undefined && csp.toLowerCase().includes("frame-ancestors");
  if (get("x-frame-options") === undefined && !cspHasFrameAncestors) {
    issues.push({
      severity: "warning",
      message:
        "No clickjacking protection: X-Frame-Options and CSP frame-ancestors are both absent.",
      recommendation: 'Add "X-Frame-Options: DENY" or a CSP frame-ancestors directive.',
    });
  }

  if (get("referrer-policy") === undefined) {
    issues.push({
      severity: "warning",
      message: "Referrer-Policy header is missing.",
      recommendation: 'Add "Referrer-Policy: strict-origin-when-cross-origin".',
    });
  }
  if (get("permissions-policy") === undefined) {
    issues.push({
      severity: "warning",
      message: "Permissions-Policy header is missing.",
      recommendation:
        'Add a Permissions-Policy disabling unused features, e.g. "camera=(), microphone=(), geolocation=()".',
    });
  }

  for (const deprecated of ["x-xss-protection", "public-key-pins"]) {
    if (get(deprecated) !== undefined) {
      issues.push({
        severity: "warning",
        message: `Deprecated security header present: ${deprecated}.`,
        recommendation: "Remove it — deprecated headers add attack surface and no protection.",
      });
    }
  }

  if (get("x-powered-by") !== undefined) {
    issues.push({
      severity: "warning",
      message: "X-Powered-By header leaks implementation details.",
      recommendation: "Remove the X-Powered-By header at the server or framework level.",
    });
  }
  const server = get("server");
  if (server !== undefined && /\/[\d.]+/.test(server)) {
    issues.push({
      severity: "warning",
      message: `Server header leaks a version number: "${server}".`,
      recommendation: "Strip the version from the Server header.",
    });
  }

  return issues;
}

export const securityHeadersCheck: Check = {
  id: "security.headers",
  category: "security",
  description: "OWASP-recommended security headers are present (including on error responses).",
  environments: ["ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const basePage = ctx.pages.get(ctx.baseUrl);
    if (basePage === undefined) {
      ctx.logger.debug("Base page not in crawl store; skipping header analysis");
      return { score: 100, findings: [] };
    }
    const https = new URL(basePage.finalUrl).protocol === "https:";
    const findings: Finding[] = analyzeHeaders(basePage.headers, { https }).map((issue) => ({
      ...issue,
      url: basePage.finalUrl,
    }));

    try {
      const probe = await ctx.fetch(new URL(PROBE_PATH, basePage.finalUrl).href);
      const missingOn404 = PARITY_HEADERS.filter(
        (name) => basePage.headers[name] !== undefined && probe.headers[name] === undefined,
      );
      if (missingOn404.length > 0) {
        findings.push({
          severity: "warning",
          url: probe.url,
          message: `Security headers present on pages but missing on error responses: ${missingOn404.join(", ")}.`,
          recommendation:
            "Configure the server/CDN to send security headers on every response, including 404s and 500s.",
        });
      }
    } catch {
      ctx.logger.debug("404 probe failed; skipping error-response parity check");
    }

    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};
```

Register in `src/engine/registry.ts` (append after `sitemapRobotsCheck`).

Tests (`tests/check-security-headers.test.ts`), all through `analyzeHeaders` plus check-level tests with `fixturePageStore` and a stubbed fetch for the probe:

1. Registered as a built-in.
2. `analyzeHeaders` on a fully hardened https response (all required headers, no leaks) → `[]`.
3. Missing HSTS on https → error; on http (`https: false`) → no HSTS issue.
4. HSTS `max-age=3600` → warning mentioning 180 days.
5. Missing/wrong `x-content-type-options` → error.
6. CSP with `frame-ancestors` suppresses the clickjacking warning even without XFO.
7. Deprecated + leaky headers (`x-xss-protection`, `x-powered-by`, `server: nginx/1.25.3`) → three warnings.
8. Check-level: hardened base page + probe returning the same headers → `{ score: 100, findings: [] }` (construct headers so `analyzeHeaders` returns zero issues).
9. Check-level: base page has CSP but probe 404 response lacks it → aggregated parity warning naming `content-security-policy`.
10. Check-level: probe fetch rejects → no parity finding, remaining findings unaffected.
11. Check-level: empty store → `{ score: 100, findings: [] }`.

**Expected integration blowback (repair, don't weaken):** existing `tests/cli.test.ts` and `tests/run-review.test.ts` cases that run with `environment: "ci"` use fixture servers with NO security headers — the new blocking check will emit errors and flip their grades/exit codes. Fix the FIXTURES, not the assertions: add a minimal hardened header set to those servers' responses:

```ts
res.setHeader("x-content-type-options", "nosniff");
res.setHeader("content-security-policy", "frame-ancestors 'none'");
res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
res.setHeader("permissions-policy", "camera=()");
```

(No HSTS needed — the fixtures are http, and `analyzeHeaders` only requires HSTS on https.) Tests that intentionally assert failure grades (e.g. the meta-tags/links/sitemap integration cases) may keep failing-grade assertions — only repair fixtures where a test asserts a PASS grade/exit 0 or a specific skipped/score value that the new check would disturb. Document every fixture you touch in your report.

TDD: tests first (FAIL: module not found), implement, PASS. Then `npm run format && npm run verify`, commit:

```bash
git add src/checks/security/headers.ts src/engine/registry.ts tests/check-security-headers.test.ts
git commit -m "feat: add security.headers check with 404-parity probe"
```

---

### Task 3: security.tls

**Files:**

- Create: `src/checks/security/tls-probe.ts`, `src/checks/security/tls.ts`, `tests/fixtures/tls/cert.pem`, `tests/fixtures/tls/key.pem`, `.gitleaks.toml`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-tls.test.ts`

**Interfaces:**

- Produces: `inspectCertificate(host: string, port: number, options?: { ca?: string; timeoutMs?: number; rejectUnauthorized?: boolean }): Promise<{ validTo: Date }>`; `certExpiryFindings(validTo: Date, now: Date): HeaderIssue-shaped items`; `findMixedContent(html: string): string[]`; `securityTlsCheck: Check`.

- [ ] **Step 1: Generate committed test fixtures** (shell one-off; NOT runtime code):

```bash
mkdir -p tests/fixtures/tls
openssl req -x509 -newkey rsa:2048 -keyout tests/fixtures/tls/key.pem -out tests/fixtures/tls/cert.pem \
  -days 36500 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
```

Create `.gitleaks.toml`:

```toml
# Test-only TLS fixtures: a self-signed localhost certificate pair used by
# tests/check-tls.test.ts. Never used outside the test suite.
[extend]
useDefault = true

[allowlist]
paths = ['''tests/fixtures/tls/.*''']
```

- [ ] **Step 2: `src/checks/security/tls-probe.ts`**

```ts
import { connect } from "node:tls";

export interface CertificateInfo {
  validTo: Date;
}

export interface InspectOptions {
  /** additional trusted CA (tests use the self-signed fixture) */
  ca?: string;
  timeoutMs?: number;
  /** default true; tests may relax */
  rejectUnauthorized?: boolean;
}

/** Open a TLS connection and read the peer certificate's expiry. */
export function inspectCertificate(
  host: string,
  port: number,
  options: InspectOptions = {},
): Promise<CertificateInfo> {
  const { ca, timeoutMs = 10_000, rejectUnauthorized = true } = options;
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port, servername: host, ca, rejectUnauthorized, timeout: timeoutMs },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        if (typeof certificate.valid_to !== "string" || certificate.valid_to === "") {
          reject(new Error("Peer returned no certificate validity information"));
          return;
        }
        resolve({ validTo: new Date(certificate.valid_to) });
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS connection to ${host}:${String(port)} timed out`));
    });
    socket.on("error", (error) => {
      reject(error);
    });
  });
}
```

- [ ] **Step 3: `src/checks/security/tls.ts`** — pure helpers + check:

```ts
import { load } from "cheerio";
import type { Check, Finding } from "../../types.js";
import { inspectCertificate } from "./tls-probe.js";

const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;
const ERROR_COST = 20;
const WARNING_COST = 5;
const MIXED_CONTENT_SAMPLE = 3;

interface TlsIssue {
  severity: "error" | "warning";
  message: string;
  recommendation: string;
}

export function certExpiryFindings(validTo: Date, now: Date): TlsIssue[] {
  const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft < 0) {
    return [
      {
        severity: "error",
        message: `TLS certificate expired ${String(-daysLeft)} days ago (${validTo.toISOString()}).`,
        recommendation: "Renew the certificate immediately — browsers are refusing connections.",
      },
    ];
  }
  if (daysLeft < EXPIRY_WARNING_DAYS) {
    return [
      {
        severity: "warning",
        message: `TLS certificate expires in ${String(daysLeft)} days (${validTo.toISOString()}).`,
        recommendation: "Renew now and confirm auto-renewal is configured.",
      },
    ];
  }
  return [];
}

/** Raw http:// resource references on a page — blocked/flagged by browsers on https pages. */
export function findMixedContent(html: string): string[] {
  const $ = load(html);
  const offenders = new Set<string>();
  const consider = (value: string | undefined): void => {
    if (value !== undefined && value.trim().toLowerCase().startsWith("http://")) {
      offenders.add(value.trim());
    }
  };
  $("img[src], script[src], iframe[src], source[src], video[src], audio[src]").each(
    (_index, element) => {
      consider($(element).attr("src"));
    },
  );
  $('link[rel~="stylesheet" i][href]').each((_index, element) => {
    consider($(element).attr("href"));
  });
  $("img[srcset], source[srcset]").each((_index, element) => {
    for (const candidate of ($(element).attr("srcset") ?? "").split(",")) {
      consider(candidate.trim().split(/\s+/)[0]);
    }
  });
  return [...offenders];
}

export const securityTlsCheck: Check = {
  id: "security.tls",
  category: "security",
  description: "HTTPS is enforced, the certificate is valid and not near expiry, no mixed content.",
  environments: ["production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const findings: Finding[] = [];
    const basePage = ctx.pages.get(ctx.baseUrl);
    const baseIsHttp = new URL(ctx.baseUrl).protocol === "http:";
    const finalUrl = basePage === undefined ? ctx.baseUrl : basePage.finalUrl;
    const finalIsHttps = new URL(finalUrl).protocol === "https:";

    if (baseIsHttp && !finalIsHttps) {
      findings.push({
        severity: "error",
        url: ctx.baseUrl,
        message: "Site is served over plain http without redirecting to https.",
        recommendation: "Redirect all http requests to https with a 301 and enable HSTS.",
      });
    }

    if (finalIsHttps) {
      const host = new URL(finalUrl).hostname;
      const port = new URL(finalUrl).port === "" ? 443 : Number(new URL(finalUrl).port);
      const probeOptions = tlsProbeOptions(ctx);
      try {
        const certificate = await inspectCertificate(host, port, probeOptions);
        for (const issue of certExpiryFindings(certificate.validTo, new Date())) {
          findings.push({ ...issue, url: finalUrl });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        findings.push(
          message.includes("timed out")
            ? {
                severity: "warning",
                url: finalUrl,
                message: `Could not inspect the TLS certificate: ${message}`,
                recommendation:
                  "Re-run the review; if this persists, inspect the host's TLS setup manually.",
              }
            : {
                severity: "error",
                url: finalUrl,
                message: `TLS certificate validation failed: ${message}`,
                recommendation: "Fix the certificate chain (expired, self-signed, or wrong host).",
              },
        );
      }
    }

    for (const page of ctx.pages.htmlPages()) {
      if (page.status < 200 || page.status >= 300) continue;
      if (new URL(page.finalUrl).protocol !== "https:") continue;
      const offenders = findMixedContent(page.body);
      if (offenders.length > 0) {
        const sample = offenders.slice(0, MIXED_CONTENT_SAMPLE).join(", ");
        findings.push({
          severity: "error",
          url: page.url,
          message: `Page loads ${String(offenders.length)} resource(s) over plain http (mixed content): ${sample}${offenders.length > MIXED_CONTENT_SAMPLE ? ", …" : ""}`,
          recommendation:
            "Serve all embedded resources over https — browsers block or warn on mixed content.",
        });
      }
    }

    ctx.logger.debug("TLS check summary", { findings: findings.length });
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};

/** Test seam: checks."security.tls".options.{ca,rejectUnauthorized} feed the probe. */
function tlsProbeOptions(ctx: Parameters<Check["run"]>[0]): {
  ca?: string;
  rejectUnauthorized?: boolean;
} {
  const raw = ctx.config.checks["security.tls"]?.options;
  const ca = typeof raw?.["ca"] === "string" ? raw["ca"] : undefined;
  const rejectUnauthorized =
    typeof raw?.["rejectUnauthorized"] === "boolean" ? raw["rejectUnauthorized"] : undefined;
  return {
    ...(ca !== undefined && { ca }),
    ...(rejectUnauthorized !== undefined && { rejectUnauthorized }),
  };
}
```

Register in `src/engine/registry.ts` (append after `securityHeadersCheck`).

- [ ] **Step 4: Tests** — `tests/check-tls.test.ts` (TDD: write first). Use `node:https.createServer` with the fixture cert/key for a real TLS endpoint; pass `options: { ca: <fixture cert text> }` through the context's check options so `inspectCertificate` trusts it.

1. Registered as a built-in.
2. `certExpiryFindings`: >30 days → `[]`; 10 days → warning with day count; past date → error saying "expired".
3. `findMixedContent`: page with `http://` img src + srcset candidate + stylesheet href → all collected; `https://` and relative refs ignored.
4. Check-level http-no-upgrade: base `http://…`, stored page finalUrl still http → error mentioning "without redirecting"; no TLS probe attempted (store base URL is http so `finalIsHttps` false).
5. Check-level happy path against the local TLS server: base url `https://127.0.0.1:<port>` — wait: the fixture cert's SAN covers `localhost` and `127.0.0.1`; connect with `host` 127.0.0.1. Store a fixture page whose url/finalUrl is the https server URL, body clean → `{ score: 100, findings: [] }`.
6. Check-level invalid cert: same server but WITHOUT `ca` in options (`rejectUnauthorized` stays true) → error finding "certificate validation failed".
7. Check-level mixed content: https fixture page (ca provided so cert passes) whose body embeds `http://insecure.example/x.js` → error finding naming the URL.

- [ ] **Step 5: Full verify and commit**

Run: `npm run format && npm run verify` — Expected: green. Confirm gitleaks would pass: `git add tests/fixtures/tls .gitleaks.toml` is included (CI's gitleaks reads `.gitleaks.toml` automatically — verify the action picks it up via default config discovery; if the gitleaks CLI step needs an explicit flag, add `--config=.gitleaks.toml` to the CI run step in the same commit).

```bash
git add -A
git commit -m "feat: add security.tls check with certificate probe and mixed-content scan"
```

---

### Task 4: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Integration test** — a ci-environment run against a plain-http fixture server asserting `security.headers` findings surface (missing x-content-type-options etc.) and `security.tls` is SKIPPED (production-only):

```ts
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
```

- [ ] **Step 2: README rows** (after the `seo.sitemap-robots` row):

```markdown
| `security.headers` | OWASP security headers present with sane values, including on error responses (ci + production) |
| `security.tls` | https enforced, certificate valid and >30 days from expiry, no mixed content (production only) |
```

- [ ] **Step 3: Verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: local http fixture via `node dist/cli.js <url> --env ci --format console` — expect `security.headers` findings and `security.tls` in the skipped list.

```bash
git add -A
git commit -m "feat: document security checks and add integration coverage"
git push -u origin feat/security-checks
gh pr create --base main --title "feat: security.headers + security.tls checks (PR 7)" --body "PR 7 of the roadmap: OWASP security-header validation (incl. 404-response parity, deprecated/leaky header detection; ci + production), TLS check (certificate validity/expiry via node:tls, http-to-https enforcement, mixed-content scan; production only), deduction scoring. Security ride-along: the fetcher now attaches configured auth headers only to trusted origins — staging credentials no longer reach third-party hosts during external-link probes. Test TLS fixtures are a committed self-signed localhost pair, gitleaks-allowlisted. No report schema change; no new dependencies (node:tls is a builtin).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

PR 8 (`seo.structured-data`) parses JSON-LD blocks. Remaining ledger backlog: guard-spy test for cross-origin child sitemaps, sitemap cap tests, PageMeta parse cache, hasAnchorTarget double pass, probe-handling dedupe, config loader guard, runner timer hygiene, reachable 3xx wording, srcset sibling under-checking, crawl-skip when all checks disabled, effectively-empty sitemapindex edge.
