/**
 * Normalize a discovered link into a crawlable page URL: resolve against the
 * page it appeared on, strip the fragment, and reject non-http(s) schemes.
 * Returns undefined for anything that is not a crawlable web URL.
 */
export function normalizePageUrl(raw: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  return url.href;
}
