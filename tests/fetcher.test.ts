import { afterEach, describe, expect, it } from "vitest";
import {
  createFetcher,
  isFollowableRedirect,
  TooManyRedirectsError,
} from "../src/fetch/fetcher.js";
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

  it("follows same-origin redirects", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/target") {
        res.end("landed");
        return;
      }
      res.writeHead(302, { Location: "/target" });
      res.end();
    });
    const result = await createFetcher()(server.url);
    expect(result.status).toBe(200);
    expect(result.body).toBe("landed");
    expect(result.redirected).toBe(true);
    expect(result.url).toBe(`${server.url}/target`);
  });

  it("does not follow cross-origin redirects and does not leak headers", async () => {
    let serverBHit = false;
    const serverB = await startServer((_req, res) => {
      serverBHit = true;
      res.end("should not be reached");
    });
    server = await startServer((_req, res) => {
      res.writeHead(302, { Location: serverB.url });
      res.end();
    });
    try {
      const result = await createFetcher({ requestHeaders: { "x-staging-token": "s3cret" } })(
        server.url,
      );
      expect(result.status).toBe(302);
      expect(serverBHit).toBe(false);
      expect(JSON.stringify(result)).not.toContain("s3cret");
    } finally {
      await serverB.close();
    }
  });

  it("returns a 3xx response as-is when it has no Location header", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302);
      res.end("no location");
    });
    const result = await createFetcher()(server.url);
    expect(result.status).toBe(302);
    expect(result.redirected).toBe(false);
    expect(result.body).toBe("no location");
  });

  it("throws after too many redirects", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302, { Location: "/" });
      res.end();
    });
    await expect(createFetcher()(server.url)).rejects.toThrow(/Too many redirects/);
  });

  it("does not retry after too many redirects", async () => {
    let calls = 0;
    server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(302, { Location: "/" });
      res.end();
    });
    await expect(createFetcher()(server.url)).rejects.toThrow(TooManyRedirectsError);
    // MAX_REDIRECTS (5) + 1 initial request = 6 hops for a single attempt; retrying would double it.
    expect(calls).toBe(6);
  });

  it("sends configured headers only to trusted origins when trustedOrigins is set", async () => {
    let seenAuth: string | undefined = "unset";
    server = await startServer((req, res) => {
      seenAuth = req.headers["x-staging-token"] as string | undefined;
      res.end("ok");
    });
    const trusted = createFetcher({
      requestHeaders: { "x-staging-token": "s3cret" },
      trustedOrigins: new Set([new URL(server.url).origin]),
    });
    await trusted(server.url);
    expect(seenAuth).toBe("s3cret");

    const untrusted = createFetcher({
      requestHeaders: { "x-staging-token": "s3cret" },
      trustedOrigins: new Set(["https://elsewhere.invalid"]),
    });
    await untrusted(server.url);
    expect(seenAuth).toBeUndefined();
  });

  it("keeps sending headers on same-origin redirect hops", async () => {
    const seen: Array<string | undefined> = [];
    server = await startServer((req, res) => {
      seen.push(req.headers["x-staging-token"] as string | undefined);
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/end");
        res.end();
        return;
      }
      res.end("done");
    });
    const fetcher = createFetcher({
      requestHeaders: { "x-staging-token": "s3cret" },
      trustedOrigins: new Set([new URL(server.url).origin]),
    });
    const result = await fetcher(`${server.url}/start`);
    expect(result.body).toBe("done");
    expect(seen).toEqual(["s3cret", "s3cret"]);
  });
});

describe("isFollowableRedirect", () => {
  it("follows http to https upgrade on the same host", () => {
    expect(isFollowableRedirect("http://example.com/", "https://example.com/")).toBe(true);
  });

  it("does not follow http to https upgrade on a different host", () => {
    expect(isFollowableRedirect("http://example.com/", "https://elsewhere.invalid/")).toBe(false);
  });

  it("does not follow https to http downgrade on the same host", () => {
    expect(isFollowableRedirect("https://example.com/", "http://example.com/")).toBe(false);
  });

  it("follows same-origin path redirects", () => {
    expect(isFollowableRedirect("http://example.com/a", "http://example.com/b")).toBe(true);
  });

  it("does not follow cross-origin redirects", () => {
    expect(isFollowableRedirect("http://example.com/", "http://elsewhere.invalid/")).toBe(false);
  });

  it("does not follow http to https upgrade with explicit non-default ports", () => {
    expect(isFollowableRedirect("http://h:8080/", "https://h/")).toBe(false);
  });
});
