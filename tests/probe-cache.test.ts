import { afterEach, describe, expect, it } from "vitest";
import { createProbeCache } from "../src/checks/probe-cache.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createProbeCache", () => {
  it("returns HEAD status without falling back when the predicate is not met", async () => {
    const methods: string[] = [];
    server = await startServer((req, res) => {
      methods.push(req.method ?? "");
      res.statusCode = 200;
      res.end("body");
    });
    const probe = createProbeCache(createFetcher());
    const result = await probe(server.url);
    expect(result).toMatchObject({ reachable: true, status: 200, body: "" });
    expect(methods).toEqual(["HEAD"]);
  });

  it("falls back to GET (capturing body) when the predicate matches", async () => {
    const methods: string[] = [];
    server = await startServer((req, res) => {
      methods.push(req.method ?? "");
      res.statusCode = req.method === "HEAD" ? 405 : 200;
      res.end(req.method === "HEAD" ? "" : "the body");
    });
    const probe = createProbeCache(createFetcher(), (status) => status === 405);
    const result = await probe(server.url);
    expect(result.status).toBe(200);
    expect(result.body).toBe("the body");
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("uses the default >= 400 fallback predicate", async () => {
    const methods: string[] = [];
    server = await startServer((req, res) => {
      methods.push(req.method ?? "");
      res.statusCode = req.method === "HEAD" ? 403 : 200;
      res.end(req.method === "HEAD" ? "" : "ok");
    });
    const result = await createProbeCache(createFetcher())(server.url);
    expect(result.status).toBe(200);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("memoizes: one probe per URL even across concurrent calls", async () => {
    let hits = 0;
    server = await startServer((_req, res) => {
      hits += 1;
      res.end("x");
    });
    const probe = createProbeCache(createFetcher());
    const url = server.url;
    await Promise.all([probe(url), probe(url), probe(url)]);
    expect(hits).toBe(1);
  });

  it("reports network failure as unreachable with a message", async () => {
    const result = await createProbeCache(createFetcher({ timeoutMs: 300 }))("http://127.0.0.1:1");
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).not.toBe("");
  });
});
