import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../src/fetch/fetcher.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createFetcher", () => {
  it("returns status, headers, and body", async () => {
    server = await startServer((_req, res) => {
      res.setHeader("x-test", "yes");
      res.end("hello");
    });
    const result = await createFetcher()(server.url);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toBe("hello");
    expect(result.headers["x-test"]).toBe("yes");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends configured request headers but never echoes them into the result", async () => {
    let seenAuth: string | undefined;
    server = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.end("ok");
    });
    const result = await createFetcher({ requestHeaders: { authorization: "Bearer s3cret" } })(
      server.url,
    );
    expect(seenAuth).toBe("Bearer s3cret");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("rejects bodies over the size cap", async () => {
    server = await startServer((_req, res) => {
      res.end("x".repeat(100));
    });
    await expect(createFetcher({ maxBodyBytes: 10 })(server.url)).rejects.toThrow(
      "exceeded 10 bytes",
    );
  });

  it("retries once after a network failure", async () => {
    let calls = 0;
    server = await startServer((req, res) => {
      calls += 1;
      if (calls === 1) req.socket.destroy();
      else res.end("recovered");
    });
    const result = await createFetcher()(server.url);
    expect(result.body).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("times out slow responses", async () => {
    server = await startServer(() => {
      /* never respond */
    });
    await expect(createFetcher({ timeoutMs: 200 })(server.url)).rejects.toThrow();
  });

  it("times out responses that stream the body forever", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.write("x");
      /* never end the response */
    });
    await expect(createFetcher({ timeoutMs: 200 })(server.url)).rejects.toThrow();
  });

  it("supports HEAD requests", async () => {
    server = await startServer((req, res) => {
      res.setHeader("x-method", req.method ?? "");
      res.end();
    });
    const result = await createFetcher()(server.url, { method: "HEAD" });
    expect(result.headers["x-method"]).toBe("HEAD");
    expect(result.body).toBe("");
  });

  it("queues requests beyond the concurrency limit", async () => {
    let concurrent = 0;
    let maxSeen = 0;
    server = await startServer((_req, res) => {
      concurrent += 1;
      maxSeen = Math.max(maxSeen, concurrent);
      setTimeout(() => {
        concurrent -= 1;
        res.end("ok");
      }, 50);
    });
    const fetcher = createFetcher({ maxConcurrent: 1 });
    await Promise.all([fetcher(server.url), fetcher(server.url)]);
    expect(maxSeen).toBe(1);
  });
});
