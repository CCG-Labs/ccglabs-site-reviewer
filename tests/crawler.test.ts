import { afterEach, describe, expect, it } from "vitest";
import { crawlSite } from "../src/crawl/crawler.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const page = (links: string[]) =>
  `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

function siteHandler(routes: Record<string, { body: string; type?: string; status?: number }>) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const route = routes[req.url ?? "/"];
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = route.status ?? 200;
    res.setHeader("content-type", route.type ?? "text/html; charset=utf-8");
    res.end(route.body);
  };
}

describe("crawlSite", () => {
  it("BFS-crawls same-origin links and records pages", async () => {
    server = await startServer(
      siteHandler({
        "/": { body: page(["/a", "/b", "https://elsewhere.invalid/x"]) },
        "/a": { body: page(["/b", "/"]) },
        "/b": { body: page([]) },
      }),
    );
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher() });
    const urls = store
      .all()
      .map((p) => new URL(p.url).pathname)
      .sort();
    expect(urls).toEqual(["/", "/a", "/b"]);
    expect(store.get(`${server.url}/a`)?.status).toBe(200);
    expect(store.stats()).toEqual({ pagesDiscovered: 3, pagesScanned: 3, capped: false });
  });

  it("seeds from sitemap.xml in addition to the base URL", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${server?.url ?? ""}/orphan</loc></url></urlset>`,
        );
        return;
      }
      siteHandler({
        "/": { body: page([]) },
        "/orphan": { body: page([]) },
      })(req, res);
    });
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher() });
    expect(store.get(`${server.url}/orphan`)?.status).toBe(200);
  });

  it("caps discovery at maxPages and reports capped", async () => {
    const links = Array.from({ length: 10 }, (_v, i) => `/p${String(i)}`);
    const routes: Record<string, { body: string }> = { "/": { body: page(links) } };
    for (const l of links) routes[l] = { body: page([]) };
    server = await startServer(siteHandler(routes));
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher(), maxPages: 4 });
    const stats = store.stats();
    expect(stats.capped).toBe(true);
    expect(stats.pagesDiscovered).toBe(4);
    expect(stats.pagesScanned).toBe(4);
  });

  it("does not extract links from non-HTML or error responses", async () => {
    server = await startServer(
      siteHandler({
        "/": { body: page(["/data.json", "/broken"]) },
        "/data.json": { body: `{"a":"<a href='/never'>x</a>"}`, type: "application/json" },
        "/broken": { body: page(["/also-never"]), status: 500 },
      }),
    );
    const store = await crawlSite({ baseUrl: server.url, fetch: createFetcher() });
    const paths = store.all().map((p) => new URL(p.url).pathname);
    expect(paths).not.toContain("/never");
    expect(paths).not.toContain("/also-never");
    expect(store.get(`${server.url}/broken`)?.status).toBe(500);
    expect(store.htmlPages().map((p) => new URL(p.url).pathname)).not.toContain("/data.json");
  });

  it("counts unfetchable pages as discovered but not scanned", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/dies") {
        req.socket.destroy();
        return;
      }
      siteHandler({ "/": { body: page(["/dies"]) } })(req, res);
    });
    const store = await crawlSite({
      baseUrl: server.url,
      fetch: createFetcher({ timeoutMs: 500 }),
    });
    const stats = store.stats();
    expect(stats.pagesDiscovered).toBe(2);
    expect(stats.pagesScanned).toBe(1);
    expect(store.get(`${server.url}/dies`)).toBeUndefined();
  });

  it("throws for an invalid base URL", async () => {
    await expect(crawlSite({ baseUrl: "not a url", fetch: createFetcher() })).rejects.toThrow(
      "Invalid base URL",
    );
  });
});
