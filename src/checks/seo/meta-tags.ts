import type { Check, CheckContext, CrawledPage, Finding } from "../../types.js";
import { extractPageMeta } from "./page-meta.js";

const TITLE_MAX_LENGTH = 60;
const DESCRIPTION_MIN_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 160;

function noindexAllowlist(ctx: CheckContext): Set<string> {
  const raw = ctx.config.checks["seo.meta-tags"]?.options?.["noindexAllow"];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((entry): entry is string => typeof entry === "string"));
}

function headerNoindex(page: CrawledPage): boolean {
  return (page.headers["x-robots-tag"] ?? "").toLowerCase().includes("noindex");
}

function pageFindings(page: CrawledPage, meta: ReturnType<typeof extractPageMeta>): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], message: string, recommendation: string): void => {
    findings.push({ severity, message, recommendation, url: page.url });
  };

  if (meta.titles.length === 0) {
    add("error", "Page has no <title>.", "Add a unique, descriptive title under 60 characters.");
  } else if (meta.titles.length > 1) {
    add(
      "error",
      `Page has ${String(meta.titles.length)} <title> tags.`,
      "Keep exactly one <title> per page.",
    );
  } else if ((meta.titles[0] ?? "").length > TITLE_MAX_LENGTH) {
    add(
      "warning",
      `Title is ${String((meta.titles[0] ?? "").length)} characters (recommended max ${String(TITLE_MAX_LENGTH)}).`,
      "Shorten the title so search results do not truncate it.",
    );
  }

  if (meta.descriptions.length === 0) {
    add(
      "error",
      "Page has no meta description.",
      "Add a unique meta description of 50–160 characters.",
    );
  } else {
    const length = (meta.descriptions[0] ?? "").length;
    if (length < DESCRIPTION_MIN_LENGTH || length > DESCRIPTION_MAX_LENGTH) {
      add(
        "warning",
        `Meta description is ${String(length)} characters (recommended ${String(DESCRIPTION_MIN_LENGTH)}–${String(DESCRIPTION_MAX_LENGTH)}).`,
        "Rewrite the description to a compelling 50–160 character summary.",
      );
    }
  }

  if (meta.canonicals.length === 0) {
    add(
      "warning",
      "Page has no rel=canonical link.",
      "Add a self-referencing canonical URL unless this page intentionally canonicalizes elsewhere.",
    );
  } else if (meta.canonicals.length > 1) {
    add(
      "error",
      `Page has ${String(meta.canonicals.length)} canonical links.`,
      "Keep exactly one rel=canonical per page.",
    );
  }

  if (meta.h1Count === 0) {
    add("warning", "Page has no <h1>.", "Add a single <h1> describing the page's main topic.");
  } else if (meta.h1Count > 1) {
    add(
      "warning",
      `Page has ${String(meta.h1Count)} <h1> elements.`,
      "Use one <h1> per page; demote the others to <h2>.",
    );
  }

  if (meta.lang === undefined) {
    add(
      "error",
      "The <html> element has no lang attribute.",
      'Add lang (e.g. <html lang="en">) so assistive technology and search engines know the language.',
    );
  }

  return findings;
}

export const metaTagsCheck: Check = {
  id: "seo.meta-tags",
  category: "seo",
  description:
    "Every page has exactly one good title, meta description, canonical, h1, and lang; titles are unique site-wide; no stray noindex.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  run(ctx) {
    const pages = ctx.pages.htmlPages().filter((page) => page.status >= 200 && page.status < 300);
    ctx.logger.debug("Evaluating meta tags", { pagesChecked: pages.length });
    if (pages.length === 0) return Promise.resolve({ score: 100, findings: [] });

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();
    const record = (finding: Finding): void => {
      findings.push(finding);
      if (finding.severity === "error" && finding.url !== undefined)
        pagesWithErrors.add(finding.url);
    };

    const allow = noindexAllowlist(ctx);
    const firstTitleUse = new Map<string, string>();
    const firstDescriptionUse = new Map<string, string>();

    for (const page of pages) {
      const meta = extractPageMeta(page.body);
      for (const finding of pageFindings(page, meta)) record(finding);

      const title = meta.titles.length === 1 ? (meta.titles[0] ?? "") : "";
      if (title !== "") {
        const firstUse = firstTitleUse.get(title);
        if (firstUse === undefined) firstTitleUse.set(title, page.url);
        else
          record({
            severity: "error",
            url: page.url,
            message: `Duplicate <title> "${title}" — already used on ${firstUse}.`,
            recommendation: "Give each page a unique title under 60 characters.",
          });
      }

      const description = meta.descriptions[0] ?? "";
      if (description !== "") {
        const firstUse = firstDescriptionUse.get(description);
        if (firstUse === undefined) firstDescriptionUse.set(description, page.url);
        else
          record({
            severity: "warning",
            url: page.url,
            message: `Duplicate meta description — already used on ${firstUse}.`,
            recommendation: "Write a unique meta description for each page.",
          });
      }

      if (ctx.environment !== "local" && !allow.has(page.url)) {
        if (meta.metaNoindex || headerNoindex(page)) {
          record({
            severity: ctx.environment === "production" ? "error" : "warning",
            url: page.url,
            message: `Page is marked noindex (${meta.metaNoindex ? "robots meta tag" : "X-Robots-Tag header"}).`,
            recommendation:
              "Remove the noindex directive before launch, or add this URL to the seo.meta-tags noindexAllow option if it is intentional.",
          });
        }
      }
    }

    const cleanPages = pages.length - pagesWithErrors.size;
    return Promise.resolve({
      score: Math.round((100 * cleanPages) / pages.length),
      findings,
    });
  },
};
