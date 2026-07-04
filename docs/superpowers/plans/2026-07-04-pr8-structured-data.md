# Site Reviewer PR 8 (seo.structured-data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `seo.structured-data` check — JSON-LD blocks must parse, declare a type, and carry the required properties for their schema type; conflicting singleton entities and site-wide absence are flagged.

**Architecture:** A pure extractor (`extractJsonLd`) pulls `<script type="application/ld+json">` blocks from each crawled HTML page, `JSON.parse`s them in try/catch (NEVER evaluates — parse failure is itself the most common real-world defect), and flattens top-level values, arrays, and `@graph` containers into entities. The check validates each entity against a required-properties table for common schema.org types, aggregates per-page findings, and uses the page-clean-ratio scoring model (like `seo.meta-tags`).

**Tech Stack:** cheerio (existing), PageStore. No new dependencies — validation is a hand-rolled table, not a schema library (per the spec: `JSON.parse` + shape validation).

## Global Constraints

- Runtime dependencies unchanged: exactly `commander`, `zod`, `jiti`, `cheerio`. Report schema UNCHANGED. No dynamic evaluation of fetched content — `JSON.parse` only.
- No `eval` / `new Function` / `child_process`. Coverage 90% gates untouched. TypeScript strict; no `any`.
- Check id `seo.structured-data`, category `seo`, `blocking: true`, weight 1, environments `["local", "ci", "production"]`.
- Severities (findings carry the page URL):
  - JSON-LD block fails `JSON.parse` → **error** (message includes the parse error and block index).
  - Entity with no `@type` (after flattening) → **warning**.
  - Entity whose `@context` (when present as a string) does not contain `schema.org` → **info** (other vocabularies are legitimate).
  - Entity missing required properties for its type → ONE **warning** per entity listing all missing property names.
  - Singleton conflict: two entities of the same singleton type (`Organization`, `WebSite`, `LocalBusiness`) on ONE page with differing `name` values → **warning**.
  - No JSON-LD anywhere on the site (zero blocks across all scanned pages) → ONE site-level **warning** attributed to the base URL ("no structured data found — rich results are unavailable").
- Required-properties table (validate ONLY these types; unknown types get no property validation):
  - `Organization`: name, url
  - `LocalBusiness`: name, address
  - `WebSite`: name, url
  - `Article` / `BlogPosting` / `NewsArticle`: headline, datePublished, author
  - `FAQPage`: mainEntity
  - `BreadcrumbList`: itemListElement
  - `Product`: name
  - `Person`: name
  - A property counts as present when the key exists and its value is not `""`, `null`, or an empty array.
- Entity flattening: a top-level array yields one entity per element; an object with `@graph` yields one entity per `@graph` element (the wrapper itself is validated only if it has its own `@type`); `@type` may be a string or array (validate against EVERY listed type that has a table entry).
- Scoring: pages = 2xx `htmlPages()`; `score = round(100 × pages-without-error-finding / pages)`; zero pages → `{ score: 100, findings: [] }`. The site-wide absence warning never affects score.
- Conventional commits. Branch: `feat/structured-data` (already created, plan committed on it), PR base `main`. Every task ends with `npm run format && npm run verify` green.

## File Structure

```
src/checks/seo/json-ld.ts          extractJsonLd (pure: html → blocks/entities/parse errors)
src/checks/seo/structured-data.ts  REQUIRED_PROPS + structuredDataCheck
src/engine/registry.ts             register structuredDataCheck
README.md                          checks table row
```

---

### Task 1: JSON-LD extractor

**Files:**

- Create: `src/checks/seo/json-ld.ts`
- Test: `tests/json-ld.test.ts`

**Interfaces:**

- Produces (Task 2 consumes):

```ts
export interface JsonLdEntity {
  /** raw parsed object (post-flattening) */
  value: Record<string, unknown>;
  /** 0-based index of the script block this entity came from */
  blockIndex: number;
}

export interface JsonLdExtraction {
  /** total script[type="application/ld+json"] blocks found */
  blockCount: number;
  entities: JsonLdEntity[];
  /** one entry per block that failed JSON.parse: its index + the parse message */
  parseErrors: Array<{ blockIndex: number; message: string }>;
}

export function extractJsonLd(html: string): JsonLdExtraction;
```

- [ ] **Step 1: Write the failing test** — `tests/json-ld.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractJsonLd } from "../src/checks/seo/json-ld.js";

const script = (content: string) => `<script type="application/ld+json">${content}</script>`;

describe("extractJsonLd", () => {
  it("parses a single object block into one entity", () => {
    const result = extractJsonLd(
      `<html><head>${script('{"@type":"Organization","name":"CCG"}')}</head></html>`,
    );
    expect(result.blockCount).toBe(1);
    expect(result.parseErrors).toEqual([]);
    expect(result.entities).toEqual([
      { value: { "@type": "Organization", name: "CCG" }, blockIndex: 0 },
    ]);
  });

  it("flattens top-level arrays and @graph containers", () => {
    const result = extractJsonLd(
      `<html><body>
        ${script('[{"@type":"Person","name":"A"},{"@type":"Person","name":"B"}]')}
        ${script('{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"S","url":"https://s.example"},{"@type":"Organization","name":"O","url":"https://o.example"}]}')}
      </body></html>`,
    );
    expect(result.blockCount).toBe(2);
    expect(result.entities.map((entity) => entity.value["@type"])).toEqual([
      "Person",
      "Person",
      "WebSite",
      "Organization",
    ]);
    expect(result.entities.map((entity) => entity.blockIndex)).toEqual([0, 0, 1, 1]);
  });

  it("records parse errors per block without aborting the others", () => {
    const result = extractJsonLd(
      `<html>${script("{not json")}${script('{"@type":"Product","name":"P"}')}</html>`,
    );
    expect(result.blockCount).toBe(2);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0]?.blockIndex).toBe(0);
    expect(result.parseErrors[0]?.message).not.toBe("");
    expect(result.entities).toHaveLength(1);
  });

  it("ignores non-JSON-LD scripts and non-object JSON values", () => {
    const result = extractJsonLd(
      `<html><script>var x = 1;</script>${script('"just a string"')}${script("42")}</html>`,
    );
    expect(result.blockCount).toBe(2);
    expect(result.parseErrors).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it("keeps a @graph wrapper as an entity when it has its own @type", () => {
    const result = extractJsonLd(
      `<html>${script('{"@type":"WebPage","name":"W","@graph":[{"@type":"Person","name":"A"}]}')}</html>`,
    );
    expect(result.entities.map((entity) => entity.value["@type"])).toEqual(["WebPage", "Person"]);
  });

  it("returns empty extraction for HTML without JSON-LD", () => {
    expect(extractJsonLd("<html><body><p>hi</p></body></html>")).toEqual({
      blockCount: 0,
      entities: [],
      parseErrors: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/json-ld.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/checks/seo/json-ld.ts`**

```ts
import { load } from "cheerio";

export interface JsonLdEntity {
  /** raw parsed object (post-flattening) */
  value: Record<string, unknown>;
  /** 0-based index of the script block this entity came from */
  blockIndex: number;
}

export interface JsonLdExtraction {
  /** total script[type="application/ld+json"] blocks found */
  blockCount: number;
  entities: JsonLdEntity[];
  parseErrors: Array<{ blockIndex: number; message: string }>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function flatten(parsed: unknown, blockIndex: number): JsonLdEntity[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((element) => flatten(element, blockIndex));
  }
  if (!isObject(parsed)) return [];
  const entities: JsonLdEntity[] = [];
  const graph = parsed["@graph"];
  const hasOwnType = parsed["@type"] !== undefined;
  if (graph === undefined || hasOwnType) entities.push({ value: parsed, blockIndex });
  if (Array.isArray(graph)) {
    for (const element of graph) {
      if (isObject(element)) entities.push({ value: element, blockIndex });
    }
  }
  return entities;
}

/** Extract and JSON.parse every JSON-LD block. Never evaluates content. */
export function extractJsonLd(html: string): JsonLdExtraction {
  const $ = load(html);
  const extraction: JsonLdExtraction = { blockCount: 0, entities: [], parseErrors: [] };
  $('script[type="application/ld+json" i]').each((_index, element) => {
    const blockIndex = extraction.blockCount;
    extraction.blockCount += 1;
    const raw = $(element).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      extraction.parseErrors.push({
        blockIndex,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    extraction.entities.push(...flatten(parsed, blockIndex));
  });
  return extraction;
}
```

Note on the flatten contract (matches the tests): an object WITHOUT `@graph` is always an entity (even without `@type` — the check flags missing `@type`); an object WITH `@graph` is an entity only when it carries its own `@type`, and its `@graph` members are entities themselves. Non-object, non-array JSON (strings/numbers) yields no entities and no error.

- [ ] **Step 4: Run test to verify it passes, then full verify**

Run: `npx vitest run tests/json-ld.test.ts` — Expected: PASS (6 tests).
Run: `npm run format && npm run verify` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/checks/seo/json-ld.ts tests/json-ld.test.ts
git commit -m "feat: add JSON-LD extraction with graph flattening and parse-error capture"
```

---

### Task 2: structuredDataCheck

**Files:**

- Create: `src/checks/seo/structured-data.ts`
- Modify: `src/engine/registry.ts`
- Test: `tests/check-structured-data.test.ts`

**Interfaces:**

- Consumes: `extractJsonLd` (Task 1), `ctx.pages.htmlPages()`, `fixturePageStore`.
- Produces: `structuredDataCheck: Check` (id `seo.structured-data`) registered in `builtinChecks` (append after `sitemapRobotsCheck`, before the security checks, keeping seo checks adjacent).

Write `src/checks/seo/structured-data.ts`:

```ts
import type { Check, Finding } from "../../types.js";
import { extractJsonLd, type JsonLdEntity } from "./json-ld.js";

const REQUIRED_PROPS: Record<string, string[]> = {
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address"],
  WebSite: ["name", "url"],
  Article: ["headline", "datePublished", "author"],
  BlogPosting: ["headline", "datePublished", "author"],
  NewsArticle: ["headline", "datePublished", "author"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  Product: ["name"],
  Person: ["name"],
};

const SINGLETON_TYPES = ["Organization", "WebSite", "LocalBusiness"];

const isPresent = (value: unknown): boolean => {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
};

function entityTypes(entity: JsonLdEntity): string[] {
  const raw = entity.value["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return [];
}

export const structuredDataCheck: Check = {
  id: "seo.structured-data",
  category: "seo",
  description:
    "JSON-LD structured data parses, declares types, and carries the required properties for rich results.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  run(ctx) {
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    if (pages.length === 0) return Promise.resolve({ score: 100, findings: [] });

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    let totalBlocks = 0;
    for (const page of pages) {
      const extraction = extractJsonLd(page.body);
      totalBlocks += extraction.blockCount;

      for (const parseError of extraction.parseErrors) {
        record({
          severity: "error",
          url: page.url,
          message: `JSON-LD block ${String(parseError.blockIndex + 1)} is not valid JSON: ${parseError.message}`,
          recommendation:
            "Fix the templating that emits this block — malformed JSON-LD is ignored by search engines entirely.",
        });
      }

      const singletonNames = new Map<string, { name: string; count: number }>();
      for (const entity of extraction.entities) {
        const types = entityTypes(entity);
        if (types.length === 0) {
          record({
            severity: "warning",
            url: page.url,
            message: `JSON-LD entity in block ${String(entity.blockIndex + 1)} has no @type.`,
            recommendation: "Add a schema.org @type so search engines can interpret the entity.",
          });
          continue;
        }
        const context = entity.value["@context"];
        if (typeof context === "string" && !context.includes("schema.org")) {
          record({
            severity: "info",
            url: page.url,
            message: `JSON-LD entity uses a non-schema.org vocabulary: ${context}`,
            recommendation:
              "Verify this vocabulary is intentional — rich results require schema.org.",
          });
        }
        for (const type of types) {
          const required = REQUIRED_PROPS[type];
          if (required !== undefined) {
            const missing = required.filter((property) => !isPresent(entity.value[property]));
            if (missing.length > 0) {
              record({
                severity: "warning",
                url: page.url,
                message: `${type} entity is missing required propert${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}.`,
                recommendation: `Add ${missing.join(", ")} — without them this ${type} is ineligible for rich results.`,
              });
            }
          }
          if (SINGLETON_TYPES.includes(type)) {
            const name = typeof entity.value["name"] === "string" ? entity.value["name"] : "";
            const seen = singletonNames.get(type);
            if (seen === undefined) singletonNames.set(type, { name, count: 1 });
            else {
              seen.count += 1;
              if (name !== "" && seen.name !== "" && name !== seen.name) {
                record({
                  severity: "warning",
                  url: page.url,
                  message: `Conflicting ${type} entities on one page: "${seen.name}" vs "${name}".`,
                  recommendation: `Emit a single canonical ${type} entity per page.`,
                });
              }
            }
          }
        }
      }
    }

    if (totalBlocks === 0) {
      findings.push({
        severity: "warning",
        url: ctx.baseUrl,
        message: "No JSON-LD structured data found on any scanned page.",
        recommendation:
          "Add schema.org JSON-LD (Organization/WebSite at minimum) — structured data drives rich results.",
      });
    }

    ctx.logger.debug("Structured data summary", {
      pagesChecked: pages.length,
      blocks: totalBlocks,
      findings: findings.length,
    });

    const cleanPages = pages.length - pagesWithErrors.size;
    return Promise.resolve({
      score: Math.round((100 * cleanPages) / pages.length),
      findings,
    });
  },
};
```

Register in `src/engine/registry.ts`.

Tests (`tests/check-structured-data.test.ts`) — follow the established contextFor/fixturePageStore pattern (environment can stay default-constructed "local"-style context like check-meta-tags tests; this check runs in all envs). Numbered spec:

1. Registered as a built-in.
2. Site with valid Organization + WebSite JSON-LD (all required props) → `{ score: 100, findings: [] }`.
3. Malformed JSON-LD block → error finding naming the block and page; score reflects the dirty page (e.g. 1 of 2 pages clean → 50).
4. Missing required properties: Article without datePublished/author → ONE warning listing BOTH missing property names; score 100 (warnings don't deduct).
5. Entity with no @type → warning.
6. Non-schema.org @context (e.g. `https://example.org/vocab`) → info finding.
7. @type as array (`["Organization","Brand"]` with name+url present) → no property warnings (Brand has no table entry; Organization satisfied).
8. Singleton conflict: two Organization entities with different names on one page → warning naming both.
9. Site with zero JSON-LD anywhere → single site-level warning attributed to the base URL; score 100.
10. Empty store → `{ score: 100, findings: [] }`.

**Expected integration blowback:** existing run-review/cli integration fixtures serve HTML with NO JSON-LD → this check adds one site-wide warning (never an error), so statuses may shift pass→warn but no grade/exit-code changes (warn doesn't fail). The cli.test.ts "--env ci" hardened fixture asserts exit 0 — unchanged (warn ≠ fail). Verify nothing else assumed zero seo-category warnings; root-cause any failure before touching it.

TDD: tests first, implement, PASS, `npm run format && npm run verify`, commit:

```bash
git add src/checks/seo/structured-data.ts src/engine/registry.ts tests/check-structured-data.test.ts
git commit -m "feat: add seo.structured-data check validating JSON-LD entities"
```

---

### Task 3: README, integration, PR

**Files:**

- Modify: `README.md`
- Test (modify): `tests/run-review.test.ts`

- [ ] **Step 1: Integration test** — append to `tests/run-review.test.ts`:

```ts
it("surfaces malformed JSON-LD from crawled pages", async () => {
  server = await startServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<html lang="en"><head><title>t</title><script type="application/ld+json">{broken</script></head><body>ok</body></html>',
    );
  });
  const report = await runReview({ url: server.url, environment: "ci" });
  const seo = report.categories.find((category) => category.id === "seo");
  const check = seo?.checks.find((entry) => entry.id === "seo.structured-data");
  expect(check?.status).toBe("fail");
  expect(
    check?.findings.some(
      (finding) => finding.severity === "error" && finding.message.includes("not valid JSON"),
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: README row** (after `seo.sitemap-robots`):

```markdown
| `seo.structured-data` | JSON-LD parses, declares @type, and carries required properties per schema.org type; flags conflicting singletons and site-wide absence |
```

- [ ] **Step 3: Verify, smoke, commit, PR**

Run: `npm run format && npm run verify` — Expected: green.
Smoke: local fixture with broken JSON-LD via `node dist/cli.js <url> --env ci --format console`.

```bash
git add -A
git commit -m "feat: document structured-data check and add integration coverage"
git push -u origin feat/structured-data
gh pr create --base main --title "feat: seo.structured-data check (PR 8)" --body "PR 8 of the roadmap: JSON-LD extraction (top-level, arrays, @graph) with parse-error capture — content is JSON.parse'd, never evaluated — plus required-property validation for common schema.org types (Organization, LocalBusiness, WebSite, Article family, FAQPage, BreadcrumbList, Product, Person), singleton-conflict detection, and a site-wide absence warning. Page-clean-ratio scoring; malformed JSON-LD is a blocking error, everything else warns. No report schema change; no new dependencies.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

(If `gh pr create` hits the GraphQL Projects deprecation error, use `gh api repos/CCG-Labs/ccglabs-site-reviewer/pulls -f ...`.)

---

## After this plan

PR 9 (`seo.social-meta`: OG/Twitter tags, og:image resolution + dimensions) closes the fetch-tier SEO set. Ledger backlog unchanged.
