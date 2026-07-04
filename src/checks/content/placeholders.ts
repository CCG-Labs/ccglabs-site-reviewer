import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { pageDom } from "../../crawl/page-dom.js";
import type { Check, CheckContext, Finding } from "../../types.js";

interface Marker {
  /** human-readable marker name for messages */
  label: string;
  severity: "error" | "warning";
  /** returns the index of the first match, or -1 */
  find(text: string): number;
}

const wordFinder = (word: string): ((text: string) => number) => {
  // eslint-disable-next-line security/detect-non-literal-regexp -- word comes from a constant, developer-authored list; no user input reaches this constructor
  const pattern = new RegExp(`\\b${word}\\b`);
  return (text) => pattern.exec(text)?.index ?? -1;
};

const DEFAULT_MARKERS: Marker[] = [
  {
    label: "lorem ipsum",
    severity: "error",
    find: (text) => text.toLowerCase().indexOf("lorem ipsum"),
  },
  { label: "{{ (unrendered template)", severity: "error", find: (text) => text.indexOf("{{") },
  { label: "}} (unrendered template)", severity: "error", find: (text) => text.indexOf("}}") },
  { label: "undefined", severity: "error", find: wordFinder("undefined") },
  { label: "NaN", severity: "error", find: wordFinder("NaN") },
  { label: "TODO", severity: "warning", find: wordFinder("TODO") },
  { label: "FIXME", severity: "warning", find: wordFinder("FIXME") },
];

interface PlaceholderOptions {
  patterns: string[];
  ignore: string[];
}

function placeholderOptions(ctx: CheckContext): PlaceholderOptions {
  const raw = ctx.config.checks["content.placeholders"]?.options;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return { patterns: strings(raw?.["patterns"]), ignore: strings(raw?.["ignore"]) };
}

/**
 * Visible text of a page: everything a reader sees, excluding script/style/
 * noscript/template content. Operates on a CLONE — the shared pageDom handle
 * is never mutated.
 */
export function extractVisibleText($: CheerioAPI): string {
  const body = $("body");
  const root: Cheerio<AnyNode> = body.length > 0 ? body : $.root();
  const clone = root.clone();
  clone.find("script, style, noscript, template").remove();
  return clone.text().replace(/\s+/g, " ").trim();
}

const excerpt = (text: string, index: number): string => {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

export const placeholdersCheck: Check = {
  id: "content.placeholders",
  category: "content",
  description:
    "No leftover placeholder text (lorem ipsum, template markers, undefined/NaN) in visible copy.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  run(ctx) {
    const options = placeholderOptions(ctx);
    const markers: Marker[] = [
      ...DEFAULT_MARKERS,
      ...options.patterns.map((pattern): Marker => ({
        label: pattern,
        severity: "error",
        find: (text) => text.toLowerCase().indexOf(pattern.toLowerCase()),
      })),
    ];

    const pages = ctx.pages
      .htmlPages()
      .filter((page) => page.status >= 200 && page.status < 300)
      .filter((page) => !options.ignore.some((pattern) => page.url.includes(pattern)));
    if (pages.length === 0) return Promise.resolve({ score: 100, findings: [] });

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();

    for (const page of pages) {
      const text = extractVisibleText(pageDom(page));
      for (const marker of markers) {
        const index = marker.find(text);
        if (index === -1) continue;
        findings.push({
          severity: marker.severity,
          url: page.url,
          message: `Placeholder "${marker.label}" found in visible text: "${excerpt(text, index)}"`,
          recommendation:
            "Replace the placeholder with real content before launch — this is visible to every visitor.",
        });
        if (marker.severity === "error") pagesWithErrors.add(page.url);
      }
    }

    ctx.logger.debug("Placeholder scan", { pagesChecked: pages.length, findings: findings.length });
    const cleanPages = pages.length - pagesWithErrors.size;
    return Promise.resolve({
      score: Math.round((100 * cleanPages) / pages.length),
      findings,
    });
  },
};
