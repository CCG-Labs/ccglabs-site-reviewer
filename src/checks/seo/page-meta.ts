import { load, type CheerioAPI } from "cheerio";

export interface PageMeta {
  titles: string[];
  descriptions: string[];
  canonicals: string[];
  h1Count: number;
  lang: string | undefined;
  /** true when a robots meta tag declares noindex (or none) */
  metaNoindex: boolean;
}

/** Extract the SEO-relevant head/body facts from one HTML document. */
export function extractPageMeta(source: string | CheerioAPI): PageMeta {
  const $ = typeof source === "string" ? load(source) : source;
  const titles = $("head > title")
    .map((_index, element) => $(element).text().trim())
    .get();
  const descriptions = $('head meta[name="description" i]')
    .map((_index, element) => ($(element).attr("content") ?? "").trim())
    .get();
  const canonicals = $('head link[rel="canonical" i]')
    .map((_index, element) => ($(element).attr("href") ?? "").trim())
    .get();
  const robotsDirectives = $('head meta[name="robots" i]')
    .map((_index, element) => ($(element).attr("content") ?? "").toLowerCase())
    .get()
    .join(",")
    .split(",")
    .map((directive) => directive.trim());
  const lang = $("html").attr("lang")?.trim();
  return {
    titles,
    descriptions,
    canonicals,
    h1Count: $("h1").length,
    lang: lang === "" || lang === undefined ? undefined : lang,
    metaNoindex: robotsDirectives.includes("noindex") || robotsDirectives.includes("none"),
  };
}
