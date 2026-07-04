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
