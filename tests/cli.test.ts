import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli/main.js";
import { reviewReportSchema } from "../src/report/schema.js";
import { startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function captureIo(): CliIo & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe("runCli", () => {
  it("exits 0 and emits a schema-valid JSON report for a passing site", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end("<html></html>");
    });
    const io = captureIo();
    const code = await runCli([server.url, "--format", "json"], io);
    expect(code).toBe(0);
    const report: unknown = JSON.parse(io.stdout());
    expect(() => reviewReportSchema.parse(report)).not.toThrow();
  });

  it("exits 1 when the review fails", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("broken");
    });
    const io = captureIo();
    expect(await runCli([server.url, "--format", "json"], io)).toBe(1);
  });

  it("exits 2 with a JSON error for an unreachable site", async () => {
    const io = captureIo();
    expect(await runCli(["http://127.0.0.1:1", "--format", "json"], io)).toBe(2);
    expect((JSON.parse(io.stderr()) as { error: string }).error).toContain("Cannot reach");
  });

  it("applies --env and --skip flags", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end("ok");
    });
    const io = captureIo();
    const code = await runCli(
      [server.url, "--env", "ci", "--skip", "functionality.reachable", "--format", "json"],
      io,
    );
    expect(code).toBe(0);
    const report = reviewReportSchema.parse(JSON.parse(io.stdout()));
    expect(report.environment).toBe("ci");
    expect(report.skipped).toContainEqual({
      id: "functionality.reachable",
      reason: "disabled by config",
    });
  });

  it("prints the console summary in the default both format", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end("ok");
    });
    const io = captureIo();
    expect(await runCli([server.url], io)).toBe(0);
    expect(io.stdout()).toContain("Grade: PASS");
    expect(io.stdout()).toContain('"reportVersion": 2');
  });

  it("exits 2 on unknown options", async () => {
    const io = captureIo();
    expect(await runCli(["http://example.test", "--bogus"], io)).toBe(2);
  });

  it("keeps a check listed in --checks", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const io = captureIo();
    const code = await runCli(
      [server.url, "--checks", "functionality.reachable", "--format", "json"],
      io,
    );
    expect(code).toBe(0);
    const report = reviewReportSchema.parse(JSON.parse(io.stdout()));
    expect(report.skipped).not.toContainEqual({
      id: "functionality.reachable",
      reason: "disabled by config",
    });
  });

  it("disables checks not listed in --checks", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const io = captureIo();
    const code = await runCli([server.url, "--checks", "some.other", "--format", "json"], io);
    expect(code).toBe(0);
    const report = reviewReportSchema.parse(JSON.parse(io.stdout()));
    expect(report.skipped).toContainEqual({
      id: "functionality.reachable",
      reason: "disabled by config",
    });
  });

  it("writes commander's own help output via the configured writeOut", async () => {
    const io = captureIo();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Usage:");
  });

  it("exits 2 on an invalid --env value", async () => {
    const io = captureIo();
    const code = await runCli(["http://example.test", "--env", "bogus", "--format", "json"], io);
    expect(code).toBe(2);
    const error = (JSON.parse(io.stderr()) as { error: string }).error;
    expect(error).toContain("--env");
  });

  it("accepts valid --max-pages and --fail-threshold values", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end("ok");
    });
    const io = captureIo();
    const code = await runCli(
      [server.url, "--max-pages", "10", "--fail-threshold", "0", "--format", "json"],
      io,
    );
    expect(code).toBe(0);
    expect(() => reviewReportSchema.parse(JSON.parse(io.stdout()))).not.toThrow();
  });

  it("exits 2 on a non-numeric --fail-threshold", async () => {
    server = await startServer((_req, res) => {
      res.end("ok");
    });
    const io = captureIo();
    const code = await runCli([server.url, "--fail-threshold", "abc", "--format", "json"], io);
    expect(code).toBe(2);
    expect(io.stdout()).toBe("");
  });
});
