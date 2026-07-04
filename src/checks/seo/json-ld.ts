import { load, type CheerioAPI } from "cheerio";

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
export function extractJsonLd(source: string | CheerioAPI): JsonLdExtraction {
  const $ = typeof source === "string" ? load(source) : source;
  const extraction: JsonLdExtraction = { blockCount: 0, entities: [], parseErrors: [] };
  $('script[type="application/ld+json" i]').each((_index, element) => {
    const blockIndex = extraction.blockCount;
    extraction.blockCount += 1;
    const raw = $(element).text();
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const entity of flatten(parsed, blockIndex)) extraction.entities.push(entity);
    } catch (error) {
      extraction.parseErrors.push({
        blockIndex,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return extraction;
}
