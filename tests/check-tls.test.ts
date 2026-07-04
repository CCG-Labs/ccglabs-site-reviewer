import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { Server } from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  certExpiryFindings,
  findMixedContent,
  securityTlsCheck,
} from "../src/checks/security/tls.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures/tls");
const CERT = readFileSync(join(FIXTURE_DIR, "cert.pem"), "utf8");
const KEY = readFileSync(join(FIXTURE_DIR, "key.pem"), "utf8");

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  baseUrl: string,
  checks: ResolvedConfig["checks"] = {},
  fetchImpl: CheckContext["fetch"] = () => Promise.reject(new Error("no fetch in this test")),
  environment: Environment = "production",
): CheckContext => ({
  baseUrl,
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    requestHeaders: {},
    checks,
    customChecks: [],
  },
  pages: fixturePageStore(pages),
  fetch: fetchImpl,
  logger: { debug: () => undefined },
});

describe("security.tls", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("security.tls");
  });

  describe("certExpiryFindings", () => {
    const now = new Date("2026-07-04T00:00:00Z");

    it("returns no findings when the certificate is not near expiry", () => {
      const validTo = new Date(now.getTime() + 90 * 86_400_000);
      expect(certExpiryFindings(validTo, now)).toEqual([]);
    });

    it("warns with the day count when the certificate expires soon", () => {
      const validTo = new Date(now.getTime() + 10 * 86_400_000);
      const findings = certExpiryFindings(validTo, now);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("warning");
      expect(findings[0]?.message).toContain("10 days");
    });

    it("errors when the certificate has already expired", () => {
      const validTo = new Date(now.getTime() - 5 * 86_400_000);
      const findings = certExpiryFindings(validTo, now);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("error");
      expect(findings[0]?.message).toContain("expired");
    });
  });

  describe("findMixedContent", () => {
    it("collects http:// references from src, srcset, and stylesheet href, ignoring https and relative refs", () => {
      const html = `
        <html>
          <head>
            <link rel="stylesheet" href="http://insecure.example/style.css">
            <link rel="stylesheet" href="https://secure.example/style.css">
          </head>
          <body>
            <img src="http://insecure.example/a.png">
            <img src="https://secure.example/b.png">
            <img src="/relative/c.png">
            <img srcset="http://insecure.example/d.png 1x, https://secure.example/e.png 2x">
          </body>
        </html>
      `;
      const offenders = findMixedContent(html);
      expect(offenders).toContain("http://insecure.example/style.css");
      expect(offenders).toContain("http://insecure.example/a.png");
      expect(offenders).toContain("http://insecure.example/d.png");
      expect(offenders).not.toContain("https://secure.example/style.css");
      expect(offenders).not.toContain("https://secure.example/b.png");
      expect(offenders).not.toContain("/relative/c.png");
      expect(offenders).not.toContain("https://secure.example/e.png");
      expect(offenders).toHaveLength(3);
    });
  });

  describe("securityTlsCheck", () => {
    it("flags http without an upgrade to https, and never attempts a TLS probe", async () => {
      const baseUrl = "http://example.com";
      const outcome = await securityTlsCheck.run(
        contextFor([{ url: baseUrl, finalUrl: baseUrl, body: "<html></html>" }], baseUrl),
      );
      const finding = outcome.findings.find((item) => item.message.includes("without redirecting"));
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("error");
      // No https page was crawled and no TLS server is listening anywhere reachable from
      // this test, so if a probe had been attempted the check would have thrown/timed out
      // instead of resolving quickly with exactly this one finding.
      expect(outcome.findings).toHaveLength(1);
    });

    describe("against a real local TLS server", () => {
      let server: Server;
      let port: number;
      let html = "<html><body>clean</body></html>";

      beforeAll(async () => {
        server = createServer({ cert: CERT, key: KEY }, (_req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(html);
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("expected an AddressInfo");
        }
        port = address.port;
      });

      afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      });

      it("scores 100 with no findings for a clean https page with a trusted cert", async () => {
        html = "<html><body>clean</body></html>";
        const baseUrl = `https://127.0.0.1:${String(port)}`;
        const outcome = await securityTlsCheck.run(
          contextFor([{ url: baseUrl, finalUrl: baseUrl, body: html }], baseUrl, {
            "security.tls": { options: { ca: CERT } },
          }),
        );
        expect(outcome).toEqual({ score: 100, findings: [] });
      });

      it(
        "errors when the certificate cannot be validated (ca not trusted)",
        { timeout: 10_000 },
        async () => {
          html = "<html><body>clean</body></html>";
          const baseUrl = `https://127.0.0.1:${String(port)}`;
          const outcome = await securityTlsCheck.run(
            contextFor([{ url: baseUrl, finalUrl: baseUrl, body: html }], baseUrl),
          );
          const finding = outcome.findings.find((item) =>
            item.message.includes("certificate validation failed"),
          );
          expect(finding).toBeDefined();
          expect(finding?.severity).toBe("error");
        },
      );

      it("flags mixed content on an https page with a trusted cert", async () => {
        html = '<html><body><script src="http://insecure.example/x.js"></script></body></html>';
        const baseUrl = `https://127.0.0.1:${String(port)}`;
        const outcome = await securityTlsCheck.run(
          contextFor([{ url: baseUrl, finalUrl: baseUrl, body: html }], baseUrl, {
            "security.tls": { options: { ca: CERT } },
          }),
        );
        const finding = outcome.findings.find((item) =>
          item.message.includes("http://insecure.example/x.js"),
        );
        expect(finding).toBeDefined();
        expect(finding?.severity).toBe("error");
      });
    });
  });
});
