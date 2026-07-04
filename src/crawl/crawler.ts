import type {
  CrawledPage,
  CrawlStats,
  FetchResult,
  PageStore,
  RateLimitedFetch,
} from "../types.js";
import { extractLinks } from "./extract-links.js";
import { fetchSitemapUrls } from "./sitemap.js";
import { normalizePageUrl } from "./url.js";

export interface CrawlOptions {
  baseUrl: string;
  fetch: RateLimitedFetch;
  /** discovery cap; crawl truncates (and flags capped) beyond this */
  maxPages?: number;
  /** simultaneous page fetches inside the crawl loop */
  concurrency?: number;
}

function isHtmlContentType(headers: Record<string, string>): boolean {
  return (headers["content-type"] ?? "").includes("text/html");
}

class SitePageStore implements PageStore {
  private readonly pages = new Map<string, CrawledPage>();
  constructor(private readonly crawlStats: CrawlStats) {}

  set(page: CrawledPage): void {
    this.pages.set(page.url, page);
  }
  get(url: string): CrawledPage | undefined {
    const normalized = normalizePageUrl(url);
    return normalized === undefined ? undefined : this.pages.get(normalized);
  }
  all(): CrawledPage[] {
    return [...this.pages.values()];
  }
  htmlPages(): CrawledPage[] {
    return this.all().filter((page) => isHtmlContentType(page.headers));
  }
  stats(): CrawlStats {
    return { ...this.crawlStats };
  }
}

export function allowedOriginsFor(base: URL): Set<string> {
  const origins = new Set([base.origin]);
  if (base.protocol === "http:") {
    const upgraded = new URL(base.href);
    upgraded.protocol = "https:";
    upgraded.port = "";
    origins.add(upgraded.origin);
  }
  return origins;
}

export async function crawlSite(options: CrawlOptions): Promise<PageStore> {
  const { fetch: fetchFn, maxPages = 200, concurrency = 5 } = options;
  const base = normalizePageUrl(options.baseUrl);
  if (base === undefined) throw new Error(`Invalid base URL: ${options.baseUrl}`);

  const allowedOrigins = allowedOriginsFor(new URL(base));
  const stats: CrawlStats = { pagesDiscovered: 0, pagesScanned: 0, capped: false };
  const store = new SitePageStore(stats);

  const discovered = new Set<string>();
  const queue: string[] = [];
  const enqueue = (url: string): void => {
    if (discovered.has(url)) return;
    if (!allowedOrigins.has(new URL(url).origin)) return;
    if (discovered.size >= maxPages) {
      stats.capped = true;
      return;
    }
    discovered.add(url);
    stats.pagesDiscovered = discovered.size;
    queue.push(url);
  };

  enqueue(base);
  for (const url of await fetchSitemapUrls(fetchFn, new URL(base).origin, maxPages, allowedOrigins))
    enqueue(url);

  const visit = async (url: string): Promise<void> => {
    let result: FetchResult;
    try {
      result = await fetchFn(url);
    } catch {
      return; // discovered but not scanned; the fetcher already retried once
    }
    const isHtml = isHtmlContentType(result.headers);
    store.set({
      url,
      finalUrl: result.url,
      status: result.status,
      ok: result.ok,
      headers: result.headers,
      body: isHtml ? result.body : "",
      redirected: result.redirected,
      durationMs: result.durationMs,
    });
    stats.pagesScanned += 1;
    if (isHtml && result.status < 400) {
      for (const link of extractLinks(result.body, result.url)) enqueue(link);
    }
  };

  await new Promise<void>((resolvePromise) => {
    let inFlight = 0;
    const pump = (): void => {
      if (queue.length === 0 && inFlight === 0) {
        resolvePromise();
        return;
      }
      while (inFlight < concurrency && queue.length > 0) {
        const url = queue.shift();
        if (url === undefined) break;
        inFlight += 1;
        void visit(url).finally(() => {
          inFlight -= 1;
          pump();
        });
      }
    };
    pump();
  });

  return store;
}
