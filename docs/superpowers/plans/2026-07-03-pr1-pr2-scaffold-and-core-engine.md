# Site Reviewer PR 1 + PR 2 (Scaffold & Core Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 1 (toolchain, CI quality/security gates) and PR 2 (core review engine + CLI + API with one built-in check), producing a releasable `@ccglabs/site-reviewer` that can review a real URL end-to-end.

**Architecture:** Check-registry engine per the approved spec (`docs/superpowers/specs/2026-07-03-site-reviewer-design.md`). Checks are plain objects implementing a `Check` interface; a runner filters them by environment, executes with timeouts, and a scorer rolls findings into a versioned zod-validated JSON report. CLI and public API are thin wrappers over `runReview()`.

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 20), tsup, vitest (+v8 coverage), ESLint (typescript-eslint strict + security plugin), Prettier, commander, zod, jiti.

## Global Constraints

- Node `>=20`, `"type": "module"`, TypeScript `strict: true`.
- Runtime dependencies for PR 1–2 limited to exactly: `commander`, `zod`, `jiti`. Any addition requires the eval-dependency process first.
- No `eval`, `new Function`, or `child_process` anywhere in `src/` (ESLint-enforced).
- `requestHeaders` (staging auth) must never appear in `FetchResult`, report JSON, or debug output.
- Coverage thresholds 90% (lines/branches/functions/statements) on `src/**`, excluding only `src/cli.ts` (3-line bin entry) and `src/index.ts` (re-exports). Never lower them.
- Report schema changes require a `REPORT_VERSION` bump (test-enforced).
- CLI exit codes: `0` pass, `1` fail, `2` tool error.
- Commit format: conventional commits (`feat:`, `test:`, `chore:`, `docs:`, `ci:`).
- PRs 3–15 are **out of scope** for this plan; each gets its own plan doc written just-in-time against the spec roadmap.

---

## PR 1 — Scaffold & attestation gates (branch: `feat/scaffold`)

### Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `src/index.ts`, `tests/index.test.ts`

**Interfaces:**
- Produces: `npm run verify` (typecheck + lint + format check + tests w/ coverage + build) — every later task ends by keeping this green.

- [ ] **Step 1: Create branch**

```bash
git checkout -b feat/scaffold
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@ccglabs/site-reviewer",
  "version": "0.1.0",
  "description": "Automated website review: crawl a URL, run environment-aware quality checks, emit a scored JSON report.",
  "type": "module",
  "engines": { "node": ">=20" },
  "license": "MIT",
  "bin": { "site-review": "./dist/cli.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "verify": "npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build"
  }
}
```

- [ ] **Step 3: Install dev dependencies and runtime dependencies**

```bash
npm install --save-dev typescript tsup vitest @vitest/coverage-v8 eslint @eslint/js typescript-eslint eslint-plugin-security prettier publint @arethetypeswrong/cli
npm install commander zod jiti
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "*.config.ts", "eslint.config.js"]
}
```

Also install node types: `npm install --save-dev @types/node`

- [ ] **Step 5: Write `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

(`src/cli.ts` arrives in Task 12; until then tsup will error on the missing entry — for PR 1 only, set `entry: ["src/index.ts"]` and Task 12 changes it back to both.)

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/cli.ts", "src/index.ts"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
```

- [ ] **Step 7: Write `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "docs/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": ["error", { paths: [{ name: "child_process", message: "No subprocesses in runtime code." }, { name: "node:child_process", message: "No subprocesses in runtime code." }] }],
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off"
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
```

- [ ] **Step 8: Write `.prettierrc.json`, `.prettierignore`, `.gitignore`**

`.prettierrc.json`:
```json
{ "printWidth": 100 }
```

`.prettierignore`:
```
dist/
coverage/
package-lock.json
```

`.gitignore`:
```
node_modules/
dist/
coverage/
*.tsbuildinfo
```

- [ ] **Step 9: Write the failing smoke test** — `tests/index.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { TOOL_NAME } from "../src/index.js";

describe("package entry", () => {
  it("exports the tool name", () => {
    expect(TOOL_NAME).toBe("@ccglabs/site-reviewer");
  });
});
```

Run: `npx vitest run` — Expected: FAIL (cannot resolve `../src/index.js`).

- [ ] **Step 10: Write `src/index.ts`**

```ts
export const TOOL_NAME = "@ccglabs/site-reviewer";
```

- [ ] **Step 11: Run full verify**

Run: `npm run format && npm run verify`
Expected: all green. Coverage passes because `src/index.ts` is excluded and nothing else exists yet.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript package with strict toolchain and coverage gates"
```

### Task 2: CI workflows and supply-chain files

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`, `SECURITY.md`, `README.md`

**Interfaces:**
- Produces: merge-blocking CI (`verify`, `audit`, `gitleaks`, CodeQL) required on every subsequent PR.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run verify
      - run: npx publint
      - run: npx attw --pack . --profile esm-only
      - run: npm audit --audit-level=high
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Write `.github/workflows/codeql.yml`**

```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "24 6 * * 1"
permissions:
  contents: read
  security-events: write
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 2b: Write `.github/workflows/release.yml`** (provenance-attested publishes only — no local `npm publish`)

```yaml
name: Release
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run verify
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

(Requires an `NPM_TOKEN` repo secret before the first release; publishing is out of scope for this plan.)

- [ ] **Step 3: Write `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      dev-dependencies:
        dependency-type: development
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 4: Write `SECURITY.md`**

```markdown
# Security Policy

## Reporting a Vulnerability

Email brian@brianreich.dev with a description and reproduction steps.
You will receive an acknowledgment within 72 hours. Please do not open
public issues for security reports.

## Runtime posture

This tool fetches and parses untrusted remote content. It never
evaluates fetched content, never spawns subprocesses, caps response
sizes and page counts, restricts crawling to the target origin, and
redacts configured auth headers from all output.
```

- [ ] **Step 5: Write `README.md`**

```markdown
# @ccglabs/site-reviewer

Automated website review: crawl a URL, run environment-aware quality
checks (SEO, security, performance, accessibility, content), and emit a
scored, machine-readable JSON report with a pass/fail grade and
recommendations for every failure.

Status: under active development. See
`docs/superpowers/specs/2026-07-03-site-reviewer-design.md` for the
design and roadmap.

## Usage

CLI and API land in PR 2 — usage docs will follow.
```

- [ ] **Step 6: Verify and commit**

Run: `npm run verify` — Expected: green.

```bash
git add -A
git commit -m "ci: add merge-blocking verify/audit/gitleaks/CodeQL workflows and supply-chain policy files"
```

- [ ] **Step 7: Open PR 1**

If no GitHub remote exists yet, pause and create the repo with the CCG Labs **create-repo** skill (applies branch protection baseline), then:

```bash
git push -u origin feat/scaffold
gh pr create --title "chore: scaffold + CI attestation gates" --body "PR 1 of the roadmap in docs/superpowers/specs/2026-07-03-site-reviewer-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Wait for merge before starting PR 2 tasks.

---

## PR 2 — Core engine, CLI, API (branch: `feat/core-engine`)

### Task 3: Shared types and versioned report schema

**Files:**
- Create: `src/types.ts`, `src/report/schema.ts`
- Test: `tests/report-schema.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - `src/types.ts`: `Environment`, `CategoryId`, `Severity`, `Finding`, `CheckOutcome`, `Logger`, `FetchResult`, `RateLimitedFetch`, `CheckContext`, `Check`, `CheckOverride`, `SiteReviewConfig`, `ResolvedConfig`
  - `src/report/schema.ts`: `REPORT_VERSION`, `reviewReportSchema`, types `ReviewReport`, `CheckReport`, `CategoryReport`

- [ ] **Step 1: Write the failing test** — `tests/report-schema.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { REPORT_VERSION, reviewReportSchema } from "../src/report/schema.js";

const validReport = {
  reportVersion: 1,
  tool: { name: "@ccglabs/site-reviewer", version: "0.1.0" },
  target: "https://example.com",
  environment: "production",
  startedAt: "2026-07-03T12:00:00.000Z",
  durationMs: 1234,
  grade: "pass",
  score: 92,
  categories: [
    {
      id: "functionality",
      score: 92,
      checks: [
        {
          id: "functionality.reachable",
          status: "pass",
          score: 100,
          blocking: true,
          findings: [],
          debug: [{ message: "Fetched base URL", data: { status: 200 } }],
        },
      ],
    },
  ],
  skipped: [{ id: "security.tls", reason: 'not applicable in environment "local"' }],
  manualChecklist: ["Submit sitemap in Google Search Console"],
};

describe("reviewReportSchema", () => {
  it("accepts a valid report", () => {
    expect(reviewReportSchema.parse(validReport)).toEqual(validReport);
  });

  it("rejects a report with the wrong version", () => {
    expect(() => reviewReportSchema.parse({ ...validReport, reportVersion: 99 })).toThrow();
  });

  it("rejects an out-of-range score", () => {
    expect(() => reviewReportSchema.parse({ ...validReport, score: 101 })).toThrow();
  });

  it("rejects findings missing a recommendation", () => {
    const bad = structuredClone(validReport);
    bad.categories[0].checks[0].findings = [{ severity: "error", message: "broken" }];
    expect(() => reviewReportSchema.parse(bad)).toThrow();
  });

  it("pins REPORT_VERSION so schema changes force a deliberate bump", () => {
    expect(REPORT_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/report-schema.test.ts`
Expected: FAIL — cannot resolve `../src/report/schema.js`.

- [ ] **Step 3: Write `src/types.ts`**

```ts
export type Environment = "local" | "ci" | "production";

export type CategoryId =
  | "functionality"
  | "performance"
  | "accessibility"
  | "seo"
  | "security"
  | "content"
  | "operations";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  message: string;
  recommendation: string;
  url?: string;
  details?: unknown;
}

export interface CheckOutcome {
  /** 0–100 */
  score: number;
  /** empty array means the check passed */
  findings: Finding[];
}

export interface Logger {
  debug(message: string, data?: unknown): void;
}

export interface FetchResult {
  /** final URL after redirects */
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  redirected: boolean;
  durationMs: number;
}

export type RateLimitedFetch = (url: string, init?: { method?: string }) => Promise<FetchResult>;

export interface CheckContext {
  baseUrl: string;
  environment: Environment;
  config: ResolvedConfig;
  fetch: RateLimitedFetch;
  logger: Logger;
}

export interface Check {
  /** e.g. "seo.meta-tags" */
  id: string;
  category: CategoryId;
  description: string;
  /** environments where this check applies; auto-skipped elsewhere */
  environments: Environment[];
  /** a failing blocking check fails the whole run regardless of score */
  blocking: boolean;
  /** relative weight within its category */
  weight: number;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export interface CheckOverride {
  enabled?: boolean;
  blocking?: boolean;
  weight?: number;
  options?: Record<string, unknown>;
}

export interface SiteReviewConfig {
  environment?: Environment;
  maxPages?: number;
  failThreshold?: number;
  requestHeaders?: Record<string, string>;
  checks?: Record<string, boolean | CheckOverride>;
  environments?: Partial<Record<Environment, Omit<SiteReviewConfig, "environments">>>;
  customChecks?: Check[];
}

export interface ResolvedConfig {
  environment: Environment;
  maxPages: number;
  failThreshold: number;
  requestHeaders: Record<string, string>;
  checks: Record<string, CheckOverride>;
  customChecks: Check[];
}
```

- [ ] **Step 4: Write `src/report/schema.ts`**

```ts
import { z } from "zod";

export const REPORT_VERSION = 1;

export const findingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  recommendation: z.string(),
  url: z.string().optional(),
  details: z.unknown().optional(),
});

export const debugEntrySchema = z.object({
  message: z.string(),
  data: z.unknown().optional(),
});

export const checkReportSchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "warn", "fail", "error"]),
  score: z.number().min(0).max(100),
  blocking: z.boolean(),
  findings: z.array(findingSchema),
  debug: z.array(debugEntrySchema),
});

export const categoryReportSchema = z.object({
  id: z.enum([
    "functionality",
    "performance",
    "accessibility",
    "seo",
    "security",
    "content",
    "operations",
  ]),
  score: z.number().min(0).max(100),
  checks: z.array(checkReportSchema),
});

export const reviewReportSchema = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  tool: z.object({ name: z.string(), version: z.string() }),
  target: z.string(),
  environment: z.enum(["local", "ci", "production"]),
  startedAt: z.string(),
  durationMs: z.number(),
  grade: z.enum(["pass", "fail"]),
  score: z.number().min(0).max(100),
  categories: z.array(categoryReportSchema),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  manualChecklist: z.array(z.string()),
});

export type ReviewReport = z.infer<typeof reviewReportSchema>;
export type CategoryReport = z.infer<typeof categoryReportSchema>;
export type CheckReport = z.infer<typeof checkReportSchema>;
```

(Note: the spec's `crawl` block is added in PR 3 alongside the crawler, with a bump to `REPORT_VERSION = 2`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/report-schema.test.ts` — Expected: PASS (5 tests). The finding-without-recommendation test may need a `@ts-expect-error` comment above the assignment; that is fine.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/core-engine   # first task of PR 2 only
git add src/types.ts src/report/schema.ts tests/report-schema.test.ts
git commit -m "feat: add core check/config types and versioned report schema"
```

### Task 4: Config resolution

**Files:**
- Create: `src/config/resolve.ts`
- Test: `tests/config-resolve.test.ts`

**Interfaces:**
- Consumes: `SiteReviewConfig`, `ResolvedConfig`, `CheckOverride`, `Environment` from `src/types.ts`
- Produces: `resolveConfig(layers: { file?: SiteReviewConfig; api?: SiteReviewConfig; cli?: SiteReviewConfig }): ResolvedConfig` and `DEFAULTS`

- [ ] **Step 1: Write the failing test** — `tests/config-resolve.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve.js";

describe("resolveConfig", () => {
  it("returns defaults when no layers are provided", () => {
    expect(resolveConfig({})).toEqual({
      environment: "local",
      maxPages: 200,
      failThreshold: 80,
      requestHeaders: {},
      checks: {},
      customChecks: [],
    });
  });

  it("applies precedence file < api < cli", () => {
    const config = resolveConfig({
      file: { failThreshold: 70, maxPages: 50 },
      api: { failThreshold: 75 },
      cli: { maxPages: 10 },
    });
    expect(config.failThreshold).toBe(75);
    expect(config.maxPages).toBe(10);
  });

  it("applies per-environment overrides for the active environment only", () => {
    const config = resolveConfig({
      file: {
        failThreshold: 70,
        environments: { production: { failThreshold: 95 }, ci: { failThreshold: 60 } },
      },
      cli: { environment: "production" },
    });
    expect(config.environment).toBe("production");
    expect(config.failThreshold).toBe(95);
  });

  it("normalizes boolean check overrides and merges layered overrides per check", () => {
    const config = resolveConfig({
      file: { checks: { "seo.meta-tags": { weight: 2 } } },
      api: { checks: { "seo.meta-tags": false } },
    });
    expect(config.checks["seo.meta-tags"]).toEqual({ weight: 2, enabled: false });
  });

  it("concatenates customChecks across layers", () => {
    const makeCheck = (id: string) => ({
      id,
      category: "seo" as const,
      description: id,
      environments: ["local" as const],
      blocking: false,
      weight: 1,
      run: () => Promise.resolve({ score: 100, findings: [] }),
    });
    const config = resolveConfig({
      file: { customChecks: [makeCheck("a")] },
      api: { customChecks: [makeCheck("b")] },
    });
    expect(config.customChecks.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config-resolve.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/config/resolve.ts`**

```ts
import type { CheckOverride, Environment, ResolvedConfig, SiteReviewConfig } from "../types.js";

export const DEFAULTS = {
  environment: "local" as Environment,
  maxPages: 200,
  failThreshold: 80,
};

function mergeLayer(base: ResolvedConfig, layer: SiteReviewConfig | undefined): ResolvedConfig {
  if (!layer) return base;
  const checks: Record<string, CheckOverride> = { ...base.checks };
  for (const [id, value] of Object.entries(layer.checks ?? {})) {
    const override: CheckOverride = typeof value === "boolean" ? { enabled: value } : value;
    checks[id] = { ...checks[id], ...override };
  }
  return {
    ...base,
    ...(layer.maxPages !== undefined && { maxPages: layer.maxPages }),
    ...(layer.failThreshold !== undefined && { failThreshold: layer.failThreshold }),
    ...(layer.requestHeaders !== undefined && { requestHeaders: layer.requestHeaders }),
    checks,
    customChecks: [...base.customChecks, ...(layer.customChecks ?? [])],
  };
}

export function resolveConfig(layers: {
  file?: SiteReviewConfig;
  api?: SiteReviewConfig;
  cli?: SiteReviewConfig;
}): ResolvedConfig {
  const environment =
    layers.cli?.environment ??
    layers.api?.environment ??
    layers.file?.environment ??
    DEFAULTS.environment;

  let resolved: ResolvedConfig = {
    environment,
    maxPages: DEFAULTS.maxPages,
    failThreshold: DEFAULTS.failThreshold,
    requestHeaders: {},
    checks: {},
    customChecks: [],
  };

  const orderedLayers = [
    layers.file,
    layers.file?.environments?.[environment],
    layers.api,
    layers.api?.environments?.[environment],
    layers.cli,
  ];
  for (const layer of orderedLayers) {
    resolved = mergeLayer(resolved, layer);
  }
  return { ...resolved, environment };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config-resolve.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/resolve.ts tests/config-resolve.test.ts
git commit -m "feat: add layered config resolution with per-environment overrides"
```

### Task 5: Config file loader and defineConfig

**Files:**
- Create: `src/config/load.ts`, `src/config/define.ts`
- Test: `tests/config-load.test.ts`

**Interfaces:**
- Produces: `loadConfigFile(cwd: string, explicitPath?: string): Promise<SiteReviewConfig | undefined>`, `defineConfig(config: SiteReviewConfig): SiteReviewConfig`

- [ ] **Step 1: Write the failing test** — `tests/config-load.test.ts`

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/define.js";
import { loadConfigFile } from "../src/config/load.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "site-review-"));

describe("loadConfigFile", () => {
  it("returns undefined when no config file exists", async () => {
    expect(await loadConfigFile(freshDir())).toBeUndefined();
  });

  it("loads a JSON config", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "site-review.config.json"), JSON.stringify({ failThreshold: 75 }));
    expect(await loadConfigFile(dir)).toEqual({ failThreshold: 75 });
  });

  it("loads a TypeScript config with a default export", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "site-review.config.ts"), "export default { failThreshold: 65 };\n");
    expect(await loadConfigFile(dir)).toEqual({ failThreshold: 65 });
  });

  it("throws when an explicit path does not exist", async () => {
    await expect(loadConfigFile(freshDir(), "missing.config.ts")).rejects.toThrow(
      "Config file not found",
    );
  });
});

describe("defineConfig", () => {
  it("returns its argument (identity helper for typed configs)", () => {
    const config = { failThreshold: 90 };
    expect(defineConfig(config)).toBe(config);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config-load.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/config/define.ts` and `src/config/load.ts`**

`src/config/define.ts`:
```ts
import type { SiteReviewConfig } from "../types.js";

export function defineConfig(config: SiteReviewConfig): SiteReviewConfig {
  return config;
}
```

`src/config/load.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import type { SiteReviewConfig } from "../types.js";

const CANDIDATES = [
  "site-review.config.ts",
  "site-review.config.js",
  "site-review.config.mjs",
  "site-review.config.json",
];

export async function loadConfigFile(
  cwd: string,
  explicitPath?: string,
): Promise<SiteReviewConfig | undefined> {
  let path: string | undefined;
  if (explicitPath !== undefined) {
    path = resolve(cwd, explicitPath);
    if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  } else {
    path = CANDIDATES.map((candidate) => resolve(cwd, candidate)).find((p) => existsSync(p));
  }
  if (path === undefined) return undefined;
  if (path.endsWith(".json")) {
    return JSON.parse(readFileSync(path, "utf8")) as SiteReviewConfig;
  }
  const jiti = createJiti(import.meta.url);
  const loaded = await jiti.import<SiteReviewConfig | { default: SiteReviewConfig }>(path);
  return "default" in loaded ? loaded.default : loaded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config-load.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/define.ts src/config/load.ts tests/config-load.test.ts
git commit -m "feat: add config file discovery/loading (ts/js/json) and defineConfig helper"
```

### Task 6: Capped, rate-limited fetch helper

**Files:**
- Create: `src/fetch/fetcher.ts`
- Test: `tests/fetcher.test.ts`, `tests/helpers/server.ts`

**Interfaces:**
- Consumes: `FetchResult`, `RateLimitedFetch` from `src/types.ts`
- Produces: `createFetcher(options?: FetcherOptions): RateLimitedFetch`, `class SiteUnreachableError extends Error`, `interface FetcherOptions { requestHeaders?: Record<string,string>; timeoutMs?: number; maxBodyBytes?: number; maxConcurrent?: number }`
- Also produces the shared test helper `startServer(handler): Promise<TestServer>` used by every later task's tests.

- [ ] **Step 1: Write the shared test server helper** — `tests/helpers/server.ts`

```ts
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolvePromise, rejectPromise) => {
        server.close((err) => (err ? rejectPromise(err) : resolvePromise()));
      }),
  };
}
```

- [ ] **Step 2: Write the failing test** — `tests/fetcher.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../src/fetch/fetcher.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createFetcher", () => {
  it("returns status, headers, and body", async () => {
    server = await startServer((_req, res) => {
      res.setHeader("x-test", "yes");
      res.end("hello");
    });
    const result = await createFetcher()(server.url);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toBe("hello");
    expect(result.headers["x-test"]).toBe("yes");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends configured request headers but never echoes them into the result", async () => {
    let seenAuth: string | undefined;
    server = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.end("ok");
    });
    const result = await createFetcher({ requestHeaders: { authorization: "Bearer s3cret" } })(
      server.url,
    );
    expect(seenAuth).toBe("Bearer s3cret");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("rejects bodies over the size cap", async () => {
    server = await startServer((_req, res) => {
      res.end("x".repeat(100));
    });
    await expect(createFetcher({ maxBodyBytes: 10 })(server.url)).rejects.toThrow(
      "exceeded 10 bytes",
    );
  });

  it("retries once after a network failure", async () => {
    let calls = 0;
    server = await startServer((req, res) => {
      calls += 1;
      if (calls === 1) req.socket.destroy();
      else res.end("recovered");
    });
    const result = await createFetcher()(server.url);
    expect(result.body).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("times out slow responses", async () => {
    server = await startServer(() => {
      /* never respond */
    });
    await expect(createFetcher({ timeoutMs: 200 })(server.url)).rejects.toThrow();
  });

  it("supports HEAD requests", async () => {
    server = await startServer((req, res) => {
      res.setHeader("x-method", req.method ?? "");
      res.end();
    });
    const result = await createFetcher()(server.url, { method: "HEAD" });
    expect(result.headers["x-method"]).toBe("HEAD");
    expect(result.body).toBe("");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/fetcher.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Write `src/fetch/fetcher.ts`**

```ts
import type { FetchResult, RateLimitedFetch } from "../types.js";

export interface FetcherOptions {
  requestHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxConcurrent?: number;
}

export class SiteUnreachableError extends Error {}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Response body exceeded ${String(maxBytes)} bytes: ${response.url}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function createFetcher(options: FetcherOptions = {}): RateLimitedFetch {
  const {
    requestHeaders = {},
    timeoutMs = 15_000,
    maxBodyBytes = 5 * 1024 * 1024,
    maxConcurrent = 5,
  } = options;

  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolvePromise) => {
      queue.push(() => {
        active += 1;
        resolvePromise();
      });
    });
  };
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  const attempt = async (url: string, method: string): Promise<FetchResult> => {
    const started = Date.now();
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readBodyCapped(response, maxBodyBytes);
    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      redirected: response.redirected,
      durationMs: Date.now() - started,
    };
  };

  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    await acquire();
    try {
      try {
        return await attempt(url, method);
      } catch (error) {
        // Size-cap violations are deliberate rejections, not transient network errors.
        if (error instanceof Error && error.message.includes("exceeded")) throw error;
        return await attempt(url, method);
      }
    } finally {
      release();
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/fetcher.test.ts` — Expected: PASS (6 tests). Note: the timeout test relies on the retry also timing out (two 200 ms attempts).

- [ ] **Step 6: Commit**

```bash
git add src/fetch/fetcher.ts tests/fetcher.test.ts tests/helpers/server.ts
git commit -m "feat: add capped, concurrency-limited fetch helper with single retry and header redaction"
```

### Task 7: Scoring

**Files:**
- Create: `src/engine/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: `Finding` from `src/types.ts`
- Produces:
  - `statusFromFindings(findings: Finding[]): "pass" | "warn" | "fail"`
  - `categoryScore(checks: Array<{ score: number; weight: number; status: string }>): number`
  - `overallScore(categoryScores: number[]): number`
  - `computeGrade(args: { overall: number; failThreshold: number; anyBlockingFailed: boolean }): "pass" | "fail"`

- [ ] **Step 1: Write the failing test** — `tests/score.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  categoryScore,
  computeGrade,
  overallScore,
  statusFromFindings,
} from "../src/engine/score.js";

const finding = (severity: "error" | "warning" | "info") => ({
  severity,
  message: "m",
  recommendation: "r",
});

describe("statusFromFindings", () => {
  it("is pass with no findings", () => {
    expect(statusFromFindings([])).toBe("pass");
  });
  it("is warn with only warnings/info", () => {
    expect(statusFromFindings([finding("warning"), finding("info")])).toBe("warn");
  });
  it("is fail with any error", () => {
    expect(statusFromFindings([finding("warning"), finding("error")])).toBe("fail");
  });
});

describe("categoryScore", () => {
  it("weight-averages check scores", () => {
    expect(
      categoryScore([
        { score: 100, weight: 1, status: "pass" },
        { score: 40, weight: 3, status: "fail" },
      ]),
    ).toBe(55);
  });
  it("excludes errored checks from the average", () => {
    expect(
      categoryScore([
        { score: 0, weight: 1, status: "error" },
        { score: 80, weight: 1, status: "pass" },
      ]),
    ).toBe(80);
  });
  it("returns 100 when nothing was scorable", () => {
    expect(categoryScore([])).toBe(100);
  });
});

describe("overallScore", () => {
  it("averages category scores", () => {
    expect(overallScore([100, 50])).toBe(75);
  });
  it("returns 100 for no categories", () => {
    expect(overallScore([])).toBe(100);
  });
});

describe("computeGrade", () => {
  it("passes at or above threshold with no blocking failures", () => {
    expect(computeGrade({ overall: 80, failThreshold: 80, anyBlockingFailed: false })).toBe("pass");
  });
  it("fails below threshold", () => {
    expect(computeGrade({ overall: 79, failThreshold: 80, anyBlockingFailed: false })).toBe("fail");
  });
  it("fails on a blocking failure regardless of score", () => {
    expect(computeGrade({ overall: 100, failThreshold: 80, anyBlockingFailed: true })).toBe("fail");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/engine/score.ts`**

```ts
import type { Finding } from "../types.js";

export function statusFromFindings(findings: Finding[]): "pass" | "warn" | "fail" {
  if (findings.some((f) => f.severity === "error")) return "fail";
  if (findings.some((f) => f.severity === "warning")) return "warn";
  return "pass";
}

export function categoryScore(
  checks: Array<{ score: number; weight: number; status: string }>,
): number {
  const scorable = checks.filter((check) => check.status !== "error");
  const totalWeight = scorable.reduce((sum, check) => sum + check.weight, 0);
  if (totalWeight === 0) return 100;
  const weighted = scorable.reduce((sum, check) => sum + check.score * check.weight, 0);
  return Math.round(weighted / totalWeight);
}

export function overallScore(categoryScores: number[]): number {
  if (categoryScores.length === 0) return 100;
  return Math.round(categoryScores.reduce((sum, s) => sum + s, 0) / categoryScores.length);
}

export function computeGrade(args: {
  overall: number;
  failThreshold: number;
  anyBlockingFailed: boolean;
}): "pass" | "fail" {
  return args.anyBlockingFailed || args.overall < args.failThreshold ? "fail" : "pass";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/score.test.ts` — Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/score.ts tests/score.test.ts
git commit -m "feat: add finding-to-status derivation and weighted category/overall scoring"
```

### Task 8: Runner and environment partitioning

**Files:**
- Create: `src/engine/runner.ts`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: `Check`, `CheckContext`, `CheckOverride`, `Environment`, `Finding`, `ResolvedConfig`, `RateLimitedFetch` from `src/types.ts`; `statusFromFindings` from `src/engine/score.ts`
- Produces:
  - `interface ExecutedCheck { check: Check; status: "pass" | "warn" | "fail" | "error"; score: number; findings: Finding[]; debug: Array<{ message: string; data?: unknown }> }`
  - `partitionChecks(checks: Check[], environment: Environment, overrides: Record<string, CheckOverride>): { toRun: Check[]; skipped: Array<{ id: string; reason: string }> }`
  - `applyOverride(check: Check, override?: CheckOverride): Check`
  - `runChecks(checks: Check[], base: Omit<CheckContext, "logger">, timeoutMs?: number): Promise<ExecutedCheck[]>`

- [ ] **Step 1: Write the failing test** — `tests/runner.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { applyOverride, partitionChecks, runChecks } from "../src/engine/runner.js";
import type { Check, CheckContext, ResolvedConfig } from "../src/types.js";

const makeCheck = (overrides: Partial<Check>): Check => ({
  id: "test.check",
  category: "functionality",
  description: "test",
  environments: ["local", "ci", "production"],
  blocking: false,
  weight: 1,
  run: () => Promise.resolve({ score: 100, findings: [] }),
  ...overrides,
});

const config: ResolvedConfig = {
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks: {},
  customChecks: [],
};

const base: Omit<CheckContext, "logger"> = {
  baseUrl: "http://example.test",
  environment: "local",
  config,
  fetch: () => Promise.reject(new Error("no fetch in this test")),
};

describe("partitionChecks", () => {
  it("skips checks not applicable to the environment, with a reason", () => {
    const { toRun, skipped } = partitionChecks(
      [makeCheck({ id: "a", environments: ["production"] }), makeCheck({ id: "b" })],
      "local",
      {},
    );
    expect(toRun.map((c) => c.id)).toEqual(["b"]);
    expect(skipped).toEqual([{ id: "a", reason: 'not applicable in environment "local"' }]);
  });

  it("skips checks disabled by config", () => {
    const { toRun, skipped } = partitionChecks([makeCheck({ id: "a" })], "local", {
      a: { enabled: false },
    });
    expect(toRun).toEqual([]);
    expect(skipped).toEqual([{ id: "a", reason: "disabled by config" }]);
  });
});

describe("applyOverride", () => {
  it("overrides blocking and weight", () => {
    const check = applyOverride(makeCheck({ blocking: false, weight: 1 }), {
      blocking: true,
      weight: 4,
    });
    expect(check.blocking).toBe(true);
    expect(check.weight).toBe(4);
  });
  it("returns the check unchanged without an override", () => {
    const check = makeCheck({});
    expect(applyOverride(check)).toBe(check);
  });
});

describe("runChecks", () => {
  it("derives status from findings and captures debug logs", async () => {
    const check = makeCheck({
      run: (ctx) => {
        ctx.logger.debug("looked at page", { n: 1 });
        return Promise.resolve({
          score: 40,
          findings: [{ severity: "error" as const, message: "broken", recommendation: "fix" }],
        });
      },
    });
    const [executed] = await runChecks([check], base);
    expect(executed?.status).toBe("fail");
    expect(executed?.score).toBe(40);
    expect(executed?.debug).toEqual([{ message: "looked at page", data: { n: 1 } }]);
  });

  it("reports a crashing check as status error without failing the run", async () => {
    const boom = makeCheck({ id: "boom", run: () => Promise.reject(new Error("kaput")) });
    const ok = makeCheck({ id: "ok" });
    const executed = await runChecks([boom, ok], base);
    expect(executed.map((e) => e.status).sort()).toEqual(["error", "pass"]);
    const errored = executed.find((e) => e.status === "error");
    expect(errored?.findings[0]?.message).toContain("kaput");
  });

  it("times out slow checks as status error", async () => {
    const slow = makeCheck({
      id: "slow",
      run: () => new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)) as never,
    });
    const [executed] = await runChecks([slow], base, 50);
    expect(executed?.status).toBe("error");
    expect(executed?.findings[0]?.message).toContain("timed out");
  });

  it("clamps out-of-range scores", async () => {
    const [executed] = await runChecks(
      [makeCheck({ run: () => Promise.resolve({ score: 250, findings: [] }) })],
      base,
    );
    expect(executed?.score).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runner.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/engine/runner.ts`**

```ts
import type { Check, CheckContext, CheckOverride, Environment, Finding } from "../types.js";
import { statusFromFindings } from "./score.js";

export interface ExecutedCheck {
  check: Check;
  status: "pass" | "warn" | "fail" | "error";
  score: number;
  findings: Finding[];
  debug: Array<{ message: string; data?: unknown }>;
}

export function partitionChecks(
  checks: Check[],
  environment: Environment,
  overrides: Record<string, CheckOverride>,
): { toRun: Check[]; skipped: Array<{ id: string; reason: string }> } {
  const toRun: Check[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const check of checks) {
    if (overrides[check.id]?.enabled === false) {
      skipped.push({ id: check.id, reason: "disabled by config" });
    } else if (!check.environments.includes(environment)) {
      skipped.push({ id: check.id, reason: `not applicable in environment "${environment}"` });
    } else {
      toRun.push(check);
    }
  }
  return { toRun, skipped };
}

export function applyOverride(check: Check, override?: CheckOverride): Check {
  if (!override) return check;
  return {
    ...check,
    blocking: override.blocking ?? check.blocking,
    weight: override.weight ?? check.weight,
  };
}

const clamp = (score: number): number => Math.min(100, Math.max(0, score));

async function withTimeout<T>(promise: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Check "${id}" timed out after ${String(ms)}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(
  checks: Check[],
  base: Omit<CheckContext, "logger">,
  timeoutMs = 60_000,
): Promise<ExecutedCheck[]> {
  return Promise.all(
    checks.map(async (check): Promise<ExecutedCheck> => {
      const debug: Array<{ message: string; data?: unknown }> = [];
      const ctx: CheckContext = {
        ...base,
        logger: {
          debug(message, data) {
            debug.push(data === undefined ? { message } : { message, data });
          },
        },
      };
      try {
        const outcome = await withTimeout(check.run(ctx), timeoutMs, check.id);
        return {
          check,
          status: statusFromFindings(outcome.findings),
          score: clamp(outcome.score),
          findings: outcome.findings,
          debug,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          check,
          status: "error",
          score: 0,
          findings: [
            {
              severity: "error",
              message: `Check crashed: ${message}`,
              recommendation:
                "This is a tool defect, not a site defect. Report it as a bug on @ccglabs/site-reviewer.",
            },
          ],
          debug,
        };
      }
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runner.test.ts` — Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/runner.ts tests/runner.test.ts
git commit -m "feat: add check runner with environment partitioning, overrides, timeouts, and crash capture"
```

### Task 9: First built-in check — functionality.reachable

**Files:**
- Create: `src/checks/functionality/reachable.ts`, `src/engine/registry.ts`
- Test: `tests/check-reachable.test.ts`

**Interfaces:**
- Consumes: `Check`, `CheckContext` from `src/types.ts`; `createFetcher` (in tests)
- Produces: `reachableCheck: Check` (id `functionality.reachable`); `builtinChecks: Check[]` from `src/engine/registry.ts`

- [ ] **Step 1: Write the failing test** — `tests/check-reachable.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { reachableCheck } from "../src/checks/functionality/reachable.js";
import { builtinChecks } from "../src/engine/registry.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import type { CheckContext, ResolvedConfig } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const config: ResolvedConfig = {
  environment: "local",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks: {},
  customChecks: [],
};

const contextFor = (baseUrl: string): CheckContext => ({
  baseUrl,
  environment: "local",
  config,
  fetch: createFetcher(),
  logger: { debug: () => undefined },
});

describe("functionality.reachable", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((c) => c.id)).toContain("functionality.reachable");
  });

  it("passes with score 100 when the base URL returns 200", async () => {
    server = await startServer((_req, res) => {
      res.end("<html></html>");
    });
    const outcome = await reachableCheck.run(contextFor(server.url));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("fails with a recommendation when the base URL returns a 4xx/5xx", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const outcome = await reachableCheck.run(contextFor(server.url));
    expect(outcome.score).toBe(0);
    expect(outcome.findings[0]?.severity).toBe("error");
    expect(outcome.findings[0]?.message).toContain("503");
    expect(outcome.findings[0]?.recommendation).not.toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check-reachable.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/checks/functionality/reachable.ts`**

```ts
import type { Check } from "../../types.js";

export const reachableCheck: Check = {
  id: "functionality.reachable",
  category: "functionality",
  description: "The base URL responds with a successful status code.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const result = await ctx.fetch(ctx.baseUrl);
    ctx.logger.debug("Fetched base URL", {
      status: result.status,
      finalUrl: result.url,
      durationMs: result.durationMs,
    });
    if (result.status >= 400) {
      return {
        score: 0,
        findings: [
          {
            severity: "error",
            url: ctx.baseUrl,
            message: `Base URL returned HTTP ${String(result.status)}.`,
            recommendation:
              "Ensure the site is deployed, the server is healthy, and the URL (including scheme and path) is correct.",
          },
        ],
      };
    }
    return { score: 100, findings: [] };
  },
};
```

- [ ] **Step 4: Write `src/engine/registry.ts`**

```ts
import { reachableCheck } from "../checks/functionality/reachable.js";
import type { Check } from "../types.js";

export const builtinChecks: Check[] = [reachableCheck];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/check-reachable.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/checks/functionality/reachable.ts src/engine/registry.ts tests/check-reachable.test.ts
git commit -m "feat: add functionality.reachable built-in check and check registry"
```

### Task 10: runReview engine assembly

**Files:**
- Create: `src/engine/run-review.ts`, `src/report/manual-checklist.ts`
- Test: `tests/run-review.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–9; `package.json` name/version via JSON import
- Produces:
  - `interface RunReviewOptions { url: string; environment?: Environment; config?: SiteReviewConfig; configFile?: SiteReviewConfig; cliConfig?: SiteReviewConfig }`
  - `runReview(options: RunReviewOptions): Promise<ReviewReport>` — throws `SiteUnreachableError` on network-level failure of the base URL
  - `MANUAL_CHECKLIST: string[]`

- [ ] **Step 1: Write the failing test** — `tests/run-review.test.ts`

```ts
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
    server = await startServer((_req, res) => {
      res.end("<html></html>");
    });
    const report = await runReview({ url: server.url });
    expect(() => reviewReportSchema.parse(report)).not.toThrow();
    expect(report.grade).toBe("pass");
    expect(report.score).toBe(100);
    expect(report.environment).toBe("local");
    expect(report.target).toBe(server.url);
    expect(report.manualChecklist.length).toBeGreaterThan(0);
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
    server = await startServer((_req, res) => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run-review.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/report/manual-checklist.ts`**

```ts
export const MANUAL_CHECKLIST: string[] = [
  "Proofread all copy against the approved content deck",
  "Spot-check on one real iOS and one real Android device",
  "Screen-reader pass on key pages (VoiceOver or NVDA)",
  "Confirm legal adequacy of privacy policy and terms with counsel",
  "Verify form notification emails arrive in real inboxes",
  "Submit the sitemap in Google Search Console",
  "Confirm a rollback plan exists for this deploy",
];
```

- [ ] **Step 4: Write `src/engine/run-review.ts`**

```ts
import packageJson from "../../package.json" with { type: "json" };
import { resolveConfig } from "../config/resolve.js";
import { createFetcher, SiteUnreachableError } from "../fetch/fetcher.js";
import { MANUAL_CHECKLIST } from "../report/manual-checklist.js";
import { REPORT_VERSION, type CategoryReport, type ReviewReport } from "../report/schema.js";
import type { CategoryId, Environment, SiteReviewConfig } from "../types.js";
import { applyOverride, partitionChecks, runChecks, type ExecutedCheck } from "./runner.js";
import { builtinChecks } from "./registry.js";
import { categoryScore, computeGrade, overallScore } from "./score.js";

export interface RunReviewOptions {
  url: string;
  environment?: Environment;
  /** API-layer config */
  config?: SiteReviewConfig;
  /** pre-loaded config file contents (the CLI loads and passes this) */
  configFile?: SiteReviewConfig;
  /** CLI-flag layer; wins over everything */
  cliConfig?: SiteReviewConfig;
}

export async function runReview(options: RunReviewOptions): Promise<ReviewReport> {
  const startedAt = new Date();
  const cliLayer: SiteReviewConfig = {
    ...options.cliConfig,
    ...(options.environment !== undefined && { environment: options.environment }),
  };
  const config = resolveConfig({ file: options.configFile, api: options.config, cli: cliLayer });
  const fetchFn = createFetcher({ requestHeaders: config.requestHeaders });

  try {
    await fetchFn(options.url, { method: "HEAD" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SiteUnreachableError(`Cannot reach ${options.url}: ${message}`);
  }

  const allChecks = [...builtinChecks, ...config.customChecks].map((check) =>
    applyOverride(check, config.checks[check.id]),
  );
  const { toRun, skipped } = partitionChecks(allChecks, config.environment, config.checks);
  const executed = await runChecks(toRun, {
    baseUrl: options.url,
    environment: config.environment,
    config,
    fetch: fetchFn,
  });

  const byCategory = new Map<CategoryId, ExecutedCheck[]>();
  for (const result of executed) {
    const list = byCategory.get(result.check.category) ?? [];
    list.push(result);
    byCategory.set(result.check.category, list);
  }

  const categories: CategoryReport[] = [...byCategory.entries()].map(([id, results]) => ({
    id,
    score: categoryScore(
      results.map((r) => ({ score: r.score, weight: r.check.weight, status: r.status })),
    ),
    checks: results.map((r) => ({
      id: r.check.id,
      status: r.status,
      score: r.score,
      blocking: r.check.blocking,
      findings: r.findings,
      debug: r.debug,
    })),
  }));

  const overall = overallScore(categories.map((c) => c.score));
  const anyBlockingFailed = executed.some((r) => r.check.blocking && r.status === "fail");

  return {
    reportVersion: REPORT_VERSION,
    tool: { name: packageJson.name, version: packageJson.version },
    target: options.url,
    environment: config.environment,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    grade: computeGrade({
      overall,
      failThreshold: config.failThreshold,
      anyBlockingFailed,
    }),
    score: overall,
    categories,
    skipped,
    manualChecklist: MANUAL_CHECKLIST,
  };
}
```

Design note (from spec): checks with status `error` are excluded from scoring and do **not** trip `anyBlockingFailed`; they surface via their findings.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/run-review.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/engine/run-review.ts src/report/manual-checklist.ts tests/run-review.test.ts
git commit -m "feat: assemble runReview engine producing schema-valid graded reports"
```

### Task 11: Reporters

**Files:**
- Create: `src/reporters/json.ts`, `src/reporters/console.ts`
- Test: `tests/reporters.test.ts`

**Interfaces:**
- Consumes: `ReviewReport` from `src/report/schema.ts`
- Produces: `renderJson(report: ReviewReport): string`, `renderConsole(report: ReviewReport): string`

- [ ] **Step 1: Write the failing test** — `tests/reporters.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { renderConsole } from "../src/reporters/console.js";
import { renderJson } from "../src/reporters/json.js";
import type { ReviewReport } from "../src/report/schema.js";

const report: ReviewReport = {
  reportVersion: 1,
  tool: { name: "@ccglabs/site-reviewer", version: "0.1.0" },
  target: "https://example.com",
  environment: "ci",
  startedAt: "2026-07-03T12:00:00.000Z",
  durationMs: 900,
  grade: "fail",
  score: 61,
  categories: [
    {
      id: "seo",
      score: 61,
      checks: [
        {
          id: "seo.meta-tags",
          status: "fail",
          score: 55,
          blocking: true,
          findings: [
            {
              severity: "error",
              url: "https://example.com/about",
              message: "Duplicate <title> shared with /team",
              recommendation: "Give each page a unique title under 60 characters.",
            },
          ],
          debug: [],
        },
      ],
    },
  ],
  skipped: [{ id: "security.tls", reason: 'not applicable in environment "ci"' }],
  manualChecklist: ["Submit the sitemap in Google Search Console"],
};

describe("renderJson", () => {
  it("round-trips the report", () => {
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });
});

describe("renderConsole", () => {
  it("includes grade, score, findings, recommendations, and skips", () => {
    const text = renderConsole(report);
    expect(text).toContain("FAIL");
    expect(text).toContain("61/100");
    expect(text).toContain("seo.meta-tags");
    expect(text).toContain("Duplicate <title> shared with /team");
    expect(text).toContain("Give each page a unique title");
    expect(text).toContain("security.tls");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reporters.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Write the reporters**

`src/reporters/json.ts`:
```ts
import type { ReviewReport } from "../report/schema.js";

export function renderJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}
```

`src/reporters/console.ts`:
```ts
import type { ReviewReport } from "../report/schema.js";

export function renderConsole(report: ReviewReport): string {
  const lines: string[] = [
    `Site review: ${report.target}`,
    `Environment: ${report.environment}   Grade: ${report.grade.toUpperCase()}   Score: ${String(report.score)}/100`,
    "",
  ];
  for (const category of report.categories) {
    lines.push(`${category.id}: ${String(category.score)}/100`);
    for (const check of category.checks) {
      lines.push(`  [${check.status}] ${check.id}`);
      for (const finding of check.findings) {
        const location = finding.url === undefined ? "" : ` (${finding.url})`;
        lines.push(`    ${finding.severity}: ${finding.message}${location}`);
        lines.push(`      fix: ${finding.recommendation}`);
      }
    }
  }
  if (report.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const skip of report.skipped) {
      lines.push(`  ${skip.id} — ${skip.reason}`);
    }
  }
  lines.push("", "Manual sign-off still required:");
  for (const item of report.manualChecklist) {
    lines.push(`  [ ] ${item}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reporters.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reporters/json.ts src/reporters/console.ts tests/reporters.test.ts
git commit -m "feat: add JSON and console reporters rendered from the canonical report"
```

### Task 12: CLI

**Files:**
- Create: `src/cli/main.ts`, `src/cli.ts`
- Modify: `tsup.config.ts` (restore `entry: ["src/index.ts", "src/cli.ts"]`)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `runReview`, `builtinChecks`, `loadConfigFile`, `renderJson`, `renderConsole`, `SiteUnreachableError`
- Produces: `runCli(argv: string[], io: CliIo): Promise<number>` where `interface CliIo { out(text: string): void; err(text: string): void }`; bin entry `src/cli.ts`

- [ ] **Step 1: Write the failing test** — `tests/cli.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli/main.js";
import { reviewReportSchema } from "../src/report/schema.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function captureIo(): CliIo & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe("runCli", () => {
  it("exits 0 and emits a schema-valid JSON report for a passing site", async () => {
    server = await startServer((_req, res) => {
      res.end("<html></html>");
    });
    const io = captureIo();
    const code = await runCli([server.url, "--format", "json"], io);
    expect(code).toBe(0);
    const report: unknown = JSON.parse(io.stdout());
    expect(() => reviewReportSchema.parse(report)).not.toThrow();
  });

  it("exits 1 when the review fails", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("broken");
    });
    const io = captureIo();
    expect(await runCli([server.url, "--format", "json"], io)).toBe(1);
  });

  it("exits 2 with a JSON error for an unreachable site", async () => {
    const io = captureIo();
    expect(await runCli(["http://127.0.0.1:1", "--format", "json"], io)).toBe(2);
    expect((JSON.parse(io.stderr()) as { error: string }).error).toContain("Cannot reach");
  });

  it("applies --env and --skip flags", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const io = captureIo();
    const code = await runCli(
      [server.url, "--env", "ci", "--skip", "functionality.reachable", "--format", "json"],
      io,
    );
    expect(code).toBe(0);
    const report = reviewReportSchema.parse(JSON.parse(io.stdout()));
    expect(report.environment).toBe("ci");
    expect(report.skipped).toContainEqual({
      id: "functionality.reachable",
      reason: "disabled by config",
    });
  });

  it("prints the console summary in the default both format", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const io = captureIo();
    expect(await runCli([server.url], io)).toBe(0);
    expect(io.stdout()).toContain("Grade: PASS");
    expect(io.stdout()).toContain('"reportVersion": 1');
  });

  it("exits 2 on unknown options", async () => {
    const io = captureIo();
    expect(await runCli(["http://example.test", "--bogus"], io)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/cli/main.ts`**

```ts
import { writeFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { loadConfigFile } from "../config/load.js";
import { runReview } from "../engine/run-review.js";
import { builtinChecks } from "../engine/registry.js";
import { renderConsole } from "../reporters/console.js";
import { renderJson } from "../reporters/json.js";
import type { CheckOverride, Environment, SiteReviewConfig } from "../types.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

interface CliOptions {
  env?: string;
  config?: string;
  checks?: string;
  skip?: string;
  maxPages?: string;
  failThreshold?: string;
  output?: string;
  format: string;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const program = new Command("site-review")
    .argument("<url>", "base URL of the site to review")
    .option("--env <environment>", "local | ci | production")
    .option("--config <path>", "path to a site-review config file")
    .option("--checks <ids>", "comma-separated check ids to run exclusively")
    .option("--skip <ids>", "comma-separated check ids to skip")
    .option("--max-pages <n>", "maximum pages to crawl")
    .option("--fail-threshold <n>", "minimum overall score to pass")
    .option("--output <file>", "write the JSON report to a file")
    .option("--format <format>", "json | console | both", "both")
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .action(async (url: string, opts: CliOptions) => {
      const checks: Record<string, boolean | CheckOverride> = {};
      for (const id of opts.skip?.split(",") ?? []) checks[id] = false;
      if (opts.checks !== undefined) {
        const keep = new Set(opts.checks.split(","));
        for (const check of builtinChecks) {
          if (!keep.has(check.id)) checks[check.id] = false;
        }
      }
      const cliConfig: SiteReviewConfig = {
        checks,
        ...(opts.env !== undefined && { environment: opts.env as Environment }),
        ...(opts.maxPages !== undefined && { maxPages: Number(opts.maxPages) }),
        ...(opts.failThreshold !== undefined && { failThreshold: Number(opts.failThreshold) }),
      };
      const configFile = await loadConfigFile(process.cwd(), opts.config);
      const report = await runReview({ url, configFile, cliConfig });
      const json = renderJson(report);
      if (opts.output !== undefined) writeFileSync(opts.output, json);
      if (opts.format === "console" || opts.format === "both") io.out(`${renderConsole(report)}\n`);
      if (opts.format === "json" || (opts.format === "both" && opts.output === undefined)) {
        io.out(`${json}\n`);
      }
      exitCode = report.grade === "pass" ? 0 : 1;
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`${JSON.stringify({ tool: "site-review", error: message })}\n`);
    return 2;
  }
}
```

- [ ] **Step 4: Write `src/cli.ts` and restore the tsup entry**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { runCli } from "./cli/main.js";

process.exitCode = await runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
```

In `tsup.config.ts`, set `entry: ["src/index.ts", "src/cli.ts"]`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.ts src/cli.ts tsup.config.ts tests/cli.test.ts
git commit -m "feat: add site-review CLI with env/skip/format flags and 0/1/2 exit codes"
```

### Task 13: Public API surface, docs, and PR

**Files:**
- Modify: `src/index.ts`, `README.md`
- Test: `tests/public-api.test.ts`

**Interfaces:**
- Produces the published API: `runReview`, `defineConfig`, `builtinChecks`, `reviewReportSchema`, `REPORT_VERSION`, `SiteUnreachableError`, and the public types.

- [ ] **Step 1: Write the failing test** — `tests/public-api.test.ts`

```ts
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public API", () => {
  it("exports the documented surface", () => {
    expect(typeof api.runReview).toBe("function");
    expect(typeof api.defineConfig).toBe("function");
    expect(Array.isArray(api.builtinChecks)).toBe(true);
    expect(api.REPORT_VERSION).toBe(1);
    expect(api.reviewReportSchema).toBeDefined();
    expect(api.SiteUnreachableError).toBeDefined();
  });
});
```

Run: `npx vitest run tests/public-api.test.ts` — Expected: FAIL (missing exports).

- [ ] **Step 2: Rewrite `src/index.ts`**

```ts
export { runReview, type RunReviewOptions } from "./engine/run-review.js";
export { defineConfig } from "./config/define.js";
export { builtinChecks } from "./engine/registry.js";
export { createFetcher, SiteUnreachableError, type FetcherOptions } from "./fetch/fetcher.js";
export {
  REPORT_VERSION,
  reviewReportSchema,
  type CategoryReport,
  type CheckReport,
  type ReviewReport,
} from "./report/schema.js";
export type {
  CategoryId,
  Check,
  CheckContext,
  CheckOutcome,
  CheckOverride,
  Environment,
  Finding,
  SiteReviewConfig,
} from "./types.js";

export const TOOL_NAME = "@ccglabs/site-reviewer";
```

Run: `npx vitest run tests/public-api.test.ts` — Expected: PASS.

- [ ] **Step 3: Update `README.md` usage section**

Replace the "Usage" section with:

````markdown
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
      for (const finding of check.findings) console.log(finding.message, "→", finding.recommendation);
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
````

- [ ] **Step 4: Full verification**

Run: `npm run format && npm run verify`
Expected: typecheck, lint, format, all tests (with ≥90% coverage), and build green. If coverage falls short, add tests for the uncovered branch — do not lower thresholds.

Then a live smoke test:
```bash
npm run build
node dist/cli.js https://example.com --env production --format console
```
Expected: console summary with `Grade: PASS` (or a graded report), exit code 0/1.

- [ ] **Step 5: Commit and open PR 2**

```bash
git add -A
git commit -m "feat: export public API and document CLI/API/config usage"
git push -u origin feat/core-engine
gh pr create --title "feat: core review engine, CLI, and public API" --body "PR 2 of the roadmap: runReview() engine, layered config, capped fetcher, scoring, reporters, CLI with exit codes, functionality.reachable check.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Then run /code-review on the branch before merge (per the spec's review process).

---

## After this plan

PRs 3–15 (crawler/PageStore, then one check per PR per the spec roadmap) each get their own plan doc in `docs/superpowers/plans/`, written just-in-time. PR 3's plan must: add `PageStore` to `CheckContext`, add the `crawl` block to the report schema, and bump `REPORT_VERSION` to 2.
