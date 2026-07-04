import { describe, expect, it } from "vitest";
import { analyzeHeaders, securityHeadersCheck } from "../src/checks/security/headers.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment, FetchResult, ResolvedConfig } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const HARDENED_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  fetchImpl: CheckContext["fetch"] = () => Promise.reject(new Error("no fetch in this test")),
  environment: Environment = "production",
  checks: ResolvedConfig["checks"] = {},
): CheckContext => ({
  baseUrl: "https://example.com",
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

describe("security.headers", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("security.headers");
  });

  describe("analyzeHeaders", () => {
    it("returns no issues for a fully hardened https response", () => {
      expect(analyzeHeaders(HARDENED_HEADERS, { https: true })).toEqual([]);
    });

    it("errors on missing HSTS over https, but not over http", () => {
      const headers = { ...HARDENED_HEADERS };
      delete headers["strict-transport-security"];

      const httpsIssues = analyzeHeaders(headers, { https: true });
      expect(
        httpsIssues.some(
          (issue) => issue.severity === "error" && issue.message.includes("Strict-Transport"),
        ),
      ).toBe(true);

      const httpIssues = analyzeHeaders(headers, { https: false });
      expect(httpIssues.some((issue) => issue.message.includes("Strict-Transport"))).toBe(false);
    });

    it("warns when HSTS max-age is too low", () => {
      const headers = { ...HARDENED_HEADERS, "strict-transport-security": "max-age=3600" };
      const issues = analyzeHeaders(headers, { https: true });
      expect(
        issues.some((issue) => issue.severity === "warning" && issue.message.includes("180 days")),
      ).toBe(true);
    });

    it("errors when x-content-type-options is missing or not nosniff", () => {
      const missing = { ...HARDENED_HEADERS };
      delete missing["x-content-type-options"];
      expect(
        analyzeHeaders(missing, { https: true }).some(
          (issue) => issue.severity === "error" && issue.message.includes("X-Content-Type-Options"),
        ),
      ).toBe(true);

      const wrong = { ...HARDENED_HEADERS, "x-content-type-options": "sniff-me" };
      expect(
        analyzeHeaders(wrong, { https: true }).some(
          (issue) => issue.severity === "error" && issue.message.includes("X-Content-Type-Options"),
        ),
      ).toBe(true);
    });

    it("suppresses the clickjacking warning when CSP has frame-ancestors, even without XFO", () => {
      const headers = {
        ...HARDENED_HEADERS,
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      };
      const issues = analyzeHeaders(headers, { https: true });
      expect(issues.some((issue) => issue.message.includes("clickjacking"))).toBe(false);
    });

    it("warns on each missing recommended header", () => {
      const issues = analyzeHeaders(
        {
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=63072000",
        },
        { https: true },
      );
      expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
      const warnings = issues.filter((issue) => issue.severity === "warning");
      expect(warnings).toHaveLength(4);
      const messages = warnings.map((issue) => issue.message.toLowerCase());
      expect(messages.some((message) => message.includes("content-security-policy"))).toBe(true);
      expect(messages.some((message) => message.includes("clickjacking"))).toBe(true);
      expect(messages.some((message) => message.includes("referrer-policy"))).toBe(true);
      expect(messages.some((message) => message.includes("permissions-policy"))).toBe(true);
    });

    it("flags deprecated and leaky headers", () => {
      const headers = {
        ...HARDENED_HEADERS,
        "x-xss-protection": "1; mode=block",
        "x-powered-by": "Express",
        server: "nginx/1.25.3",
      };
      const issues = analyzeHeaders(headers, { https: true });
      const warnings = issues.filter((issue) => issue.severity === "warning");
      expect(warnings.some((issue) => issue.message.includes("x-xss-protection"))).toBe(true);
      expect(warnings.some((issue) => issue.message.includes("X-Powered-By"))).toBe(true);
      expect(warnings.some((issue) => issue.message.includes("nginx/1.25.3"))).toBe(true);
      expect(warnings).toHaveLength(3);
    });
  });

  describe("securityHeadersCheck", () => {
    const probeFetch =
      (headers: Record<string, string>): CheckContext["fetch"] =>
      (url: string): Promise<FetchResult> =>
        Promise.resolve({
          url,
          status: 404,
          ok: false,
          headers,
          body: "not found",
          redirected: false,
          durationMs: 1,
        });

    it("scores 100 with no findings when the base page and its 404 probe are both hardened", async () => {
      const outcome = await securityHeadersCheck.run(
        contextFor(
          [{ url: "https://example.com/", headers: HARDENED_HEADERS }],
          probeFetch(HARDENED_HEADERS),
        ),
      );
      expect(outcome).toEqual({ score: 100, findings: [] });
    });

    it("warns on parity mismatch when the 404 probe lacks a header the base page has", async () => {
      const probeHeaders = { ...HARDENED_HEADERS };
      delete probeHeaders["content-security-policy"];
      const outcome = await securityHeadersCheck.run(
        contextFor(
          [{ url: "https://example.com/", headers: HARDENED_HEADERS }],
          probeFetch(probeHeaders),
        ),
      );
      const parity = outcome.findings.find((finding) =>
        finding.message.includes("missing on error responses"),
      );
      expect(parity).toBeDefined();
      expect(parity?.message).toContain("content-security-policy");
    });

    it("skips the parity finding (but keeps other findings) when the probe fetch rejects", async () => {
      const headersMissingCto = { ...HARDENED_HEADERS };
      delete headersMissingCto["x-content-type-options"];
      const outcome = await securityHeadersCheck.run(
        contextFor([{ url: "https://example.com/", headers: headersMissingCto }], () =>
          Promise.reject(new Error("network down")),
        ),
      );
      expect(outcome.findings.some((finding) => finding.message.includes("missing on error"))).toBe(
        false,
      );
      expect(
        outcome.findings.some((finding) => finding.message.includes("X-Content-Type-Options")),
      ).toBe(true);
    });

    it("returns a clean pass when the page store is empty", async () => {
      const outcome = await securityHeadersCheck.run(contextFor([]));
      expect(outcome).toEqual({ score: 100, findings: [] });
    });
  });
});
