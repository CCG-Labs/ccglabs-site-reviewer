import { load } from "cheerio";
import { normalizePageUrl } from "../../crawl/url.js";

export interface PageLink {
  /** fragment-stripped absolute URL */
  url: string;
  /** decoded fragment, when the link had one */
  fragment: string | undefined;
}

export interface PageRefs {
  links: PageLink[];
  assets: string[];
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function parseSrcset(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url !== "");
}

/** Extract every anchor link (fragment preserved) and asset reference from one HTML page. */
export function extractPageRefs(html: string, pageUrl: string): PageRefs {
  const $ = load(html);

  const links = new Map<string, PageLink>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    const fragment = resolved.hash === "" ? undefined : decodeFragment(resolved.hash.slice(1));
    resolved.hash = "";
    const key = `${resolved.href}#${fragment ?? "�"}`;
    if (!links.has(key)) links.set(key, { url: resolved.href, fragment });
  });

  const assets = new Set<string>();
  const addAsset = (raw: string | undefined): void => {
    if (raw === undefined || raw.trim() === "") return;
    const normalized = normalizePageUrl(raw, pageUrl);
    if (normalized !== undefined) assets.add(normalized);
  };
  $("img[src], source[src], video[src], audio[src], script[src]").each((_index, element) => {
    addAsset($(element).attr("src"));
  });
  $("img[srcset], source[srcset]").each((_index, element) => {
    for (const candidate of parseSrcset($(element).attr("srcset") ?? "")) addAsset(candidate);
  });
  $('link[rel~="stylesheet" i][href]').each((_index, element) => {
    addAsset($(element).attr("href"));
  });

  return { links: [...links.values()], assets: [...assets] };
}

/** True when the fragment resolves to an element on the page (id or legacy a[name]). */
export function hasAnchorTarget(html: string, fragment: string): boolean {
  if (fragment === "" || fragment === "top") return true;
  const $ = load(html);
  const idMatch = $("[id]")
    .toArray()
    .some((element) => $(element).attr("id") === fragment);
  if (idMatch) return true;
  return $("a[name]")
    .toArray()
    .some((element) => $(element).attr("name") === fragment);
}
