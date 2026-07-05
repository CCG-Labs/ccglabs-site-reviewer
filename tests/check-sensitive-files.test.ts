import { afterEach, describe, expect, it } from "vitest";
import { sensitiveFilesCheck } from "../src/checks/security/sensitive-files.js";
import { builtinChecks } from "../src/engine/registry.js";
import { createFetcher } from "../src/fetch/fetcher.js";
import type { CheckContext, CheckOverride, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const configWith = (checks: Record<string, CheckOverride> = {}): ResolvedConfig => ({
  environment: "ci",
  maxPages: 200,
  failThreshold: 80,
  requestHeaders: {},
  checks,
  customChecks: [],
});

const contextFor = (baseUrl: string, checks: Record<string, CheckOverride> = {}): CheckContext => ({
  baseUrl,
  environment: "ci",
  config: configWith(checks),
  pages: fixturePageStore(),
  fetch: createFetcher(),
  logger: { debug: () => undefined },
});

describe("security.sensitive-files", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("security.sensitive-files");
  });

  it("passes with score 100 when every sensitive path 404s", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(contextFor(server.url));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags an exposed /.env served as text/plain 200", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/.env") {
        res.setHeader("content-type", "text/plain");
        res.end("DB_PASSWORD=secret");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(contextFor(server.url));
    expect(outcome.score).toBe(80);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("error");
    expect(outcome.findings[0]?.message).toContain("/.env");
  });

  it("flags an exposed /.git/HEAD served as text/plain 200", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/.git/HEAD") {
        res.setHeader("content-type", "text/plain");
        res.end("ref: refs/heads/main");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(contextFor(server.url));
    expect(outcome.findings.some((finding) => finding.message.includes("/.git/HEAD"))).toBe(true);
    expect(outcome.findings.some((finding) => finding.severity === "error")).toBe(true);
  });

  it("does not flag a catch-all SPA that returns 200 text/html for everything", async () => {
    server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body>app shell</body></html>");
    });
    const outcome = await sensitiveFilesCheck.run(contextFor(server.url));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("probes configured additionalPaths in addition to the defaults", async () => {
    const hits: string[] = [];
    server = await startServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/secret.txt") {
        res.setHeader("content-type", "text/plain");
        res.end("shh");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(
      contextFor(server.url, {
        "security.sensitive-files": { options: { additionalPaths: ["/secret.txt"] } },
      }),
    );
    expect(outcome.findings.some((finding) => finding.message.includes("/secret.txt"))).toBe(true);
    expect(hits).toContain("/.env");
    expect(hits).toContain("/secret.txt");
  });

  it("replaces defaults entirely when paths is configured", async () => {
    const hits: string[] = [];
    server = await startServer((req, res) => {
      hits.push(req.url ?? "");
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(
      contextFor(server.url, {
        "security.sensitive-files": { options: { paths: ["/only-this"] } },
      }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(hits).toContain("/only-this");
    expect(hits).not.toContain("/.env");
  });

  it("skips paths matching an ignore pattern", async () => {
    const hits: string[] = [];
    server = await startServer((req, res) => {
      hits.push(req.url ?? "");
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(
      contextFor(server.url, {
        "security.sensitive-files": { options: { ignore: [".git"] } },
      }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(hits).not.toContain("/.git/HEAD");
    expect(hits).not.toContain("/.git/config");
  });

  it("caps the probed path list at 100 entries", async () => {
    const hits: string[] = [];
    server = await startServer((req, res) => {
      hits.push(req.url ?? "");
      res.statusCode = 404;
      res.end("not found");
    });
    const paths = Array.from({ length: 150 }, (_unused, index) => `/f${String(index)}`);
    const outcome = await sensitiveFilesCheck.run(
      contextFor(server.url, { "security.sensitive-files": { options: { paths } } }),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
    expect(hits).toHaveLength(100);
    expect(new Set(hits).size).toBe(100);
    expect(hits).toContain("/f0");
    expect(hits).toContain("/f99");
    expect(hits).not.toContain("/f100");
  });

  it("never requests absolute-URL path entries pointing at third-party hosts", async () => {
    const hits: string[] = [];
    server = await startServer((req, res) => {
      hits.push(req.url ?? "");
      res.statusCode = 404;
      res.end("not found");
    });
    const requested: string[] = [];
    const base = createFetcher();
    const recordingFetch: CheckContext["fetch"] = (url, init) => {
      requested.push(url);
      return base(url, init);
    };
    const outcome = await sensitiveFilesCheck.run({
      ...contextFor(server.url, {
        "security.sensitive-files": { options: { paths: ["https://evil.example/x", "/.env"] } },
      }),
      fetch: recordingFetch,
    });
    expect(requested.some((url) => url.includes("evil.example"))).toBe(false);
    expect(hits).toEqual(["/.env"]);
    expect(outcome.findings.some((finding) => finding.message.includes("evil.example"))).toBe(
      false,
    );
    expect(outcome.findings.some((finding) => (finding.url ?? "").includes("evil.example"))).toBe(
      false,
    );
  });

  it("does not flag a 200 response with an empty body", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/.env") {
        res.setHeader("content-type", "text/plain");
        res.end("");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const outcome = await sensitiveFilesCheck.run(contextFor(server.url));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});
