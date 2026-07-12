import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../src/fetch/fetcher.js";
import { fetchSitemapUrls } from "../src/crawl/sitemap.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const urlset = (origin: string) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/about#frag</loc></url>
  <url><loc>https://elsewhere.invalid/page</loc></url>
</urlset>`;

describe("fetchSitemapUrls", () => {
  it("returns normalized same-origin URLs from a urlset sitemap", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(urlset(`http://127.0.0.1:${new URL(server?.url ?? "").port}`));
      } else res.end("ok");
    });
    const origin = new URL(server.url).origin;
    const urls = await fetchSitemapUrls(
      createFetcher(),
      [`${server.url}/sitemap.xml`],
      500,
      new Set([origin]),
    );
    expect(urls).toEqual([`${server.url}/`, `${server.url}/about`]);
  });

  it("follows one level of sitemapindex", async () => {
    server = await startServer((req, res) => {
      const origin = server?.url ?? "";
      res.setHeader("content-type", "application/xml");
      if (req.url === "/sitemap.xml") {
        res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap>
          <sitemap><loc>https://elsewhere.invalid/other.xml</loc></sitemap>
        </sitemapindex>`);
      } else if (req.url === "/sitemap-pages.xml") {
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${origin}/deep</loc></url>
        </urlset>`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const origin = new URL(server.url).origin;
    expect(
      await fetchSitemapUrls(
        createFetcher(),
        [`${server.url}/sitemap.xml`],
        500,
        new Set([origin]),
      ),
    ).toEqual([`${server.url}/deep`]);
  });

  it("merges results from multiple declared sitemaps, deduping overlaps", async () => {
    server = await startServer((req, res) => {
      const origin = server?.url ?? "";
      res.setHeader("content-type", "application/xml");
      if (req.url === "/sitemap-products.xml") {
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${origin}/products/a</loc></url>
          <url><loc>${origin}/shared</loc></url>
        </urlset>`);
      } else if (req.url === "/sitemap-blog.xml") {
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${origin}/blog/a</loc></url>
          <url><loc>${origin}/shared</loc></url>
        </urlset>`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const origin = new URL(server.url).origin;
    const urls = await fetchSitemapUrls(
      createFetcher(),
      [`${server.url}/sitemap-products.xml`, `${server.url}/sitemap-blog.xml`],
      500,
      new Set([origin]),
    );
    expect(urls).toEqual([
      `${server.url}/products/a`,
      `${server.url}/shared`,
      `${server.url}/blog/a`,
    ]);
  });

  it("returns [] when the sitemap is missing or malformed", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") res.end("%%% not xml %%%");
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    const origin = new URL(server.url).origin;
    expect(
      await fetchSitemapUrls(
        createFetcher(),
        [`${server.url}/sitemap.xml`],
        500,
        new Set([origin]),
      ),
    ).toEqual([]);
    const missing = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    try {
      const missingOrigin = new URL(missing.url).origin;
      expect(
        await fetchSitemapUrls(
          createFetcher(),
          [`${missing.url}/sitemap.xml`],
          500,
          new Set([missingOrigin]),
        ),
      ).toEqual([]);
    } finally {
      await missing.close();
    }
  });

  it("returns URLs whose origin is in the allowed set even if it differs from the fetch origin", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/page</loc></url>
        </urlset>`);
      } else res.end("ok");
    });
    const serverOrigin = new URL(server.url).origin;

    expect(
      await fetchSitemapUrls(
        createFetcher(),
        [`${server.url}/sitemap.xml`],
        500,
        new Set([serverOrigin]),
      ),
    ).toEqual([]);

    expect(
      await fetchSitemapUrls(
        createFetcher(),
        [`${server.url}/sitemap.xml`],
        500,
        new Set([serverOrigin, "https://example.com"]),
      ),
    ).toEqual(["https://example.com/page"]);
  });

  it("caps the number of returned URLs at the limit", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        const origin = server?.url ?? "";
        const entries = Array.from(
          { length: 20 },
          (_v, i) => `<url><loc>${origin}/p${String(i)}</loc></url>`,
        ).join("");
        res.setHeader("content-type", "application/xml");
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
        );
      } else res.end("ok");
    });
    const origin = new URL(server.url).origin;
    expect(
      await fetchSitemapUrls(createFetcher(), [`${server.url}/sitemap.xml`], 5, new Set([origin])),
    ).toHaveLength(5);
  });
});
