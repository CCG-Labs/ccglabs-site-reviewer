import type { Check, Finding } from "../../types.js";

const PROBE_PATH = "/__site-review-404-probe__";
const HSTS_MIN_MAX_AGE = 15_552_000; // 180 days
const ERROR_COST = 20;
const WARNING_COST = 5;

/** Required headers whose 404-parity we verify. */
const PARITY_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "content-security-policy",
  "referrer-policy",
  "permissions-policy",
];

interface HeaderIssue {
  severity: "error" | "warning";
  message: string;
  recommendation: string;
}

export function analyzeHeaders(
  headers: Record<string, string>,
  options: { https: boolean },
): HeaderIssue[] {
  const issues: HeaderIssue[] = [];
  const get = (name: string): string | undefined => headers[name];

  if (options.https) {
    const hsts = get("strict-transport-security");
    if (hsts === undefined) {
      issues.push({
        severity: "error",
        message: "Strict-Transport-Security header is missing.",
        recommendation: 'Add "Strict-Transport-Security: max-age=63072000; includeSubDomains".',
      });
    } else {
      const maxAge = /max-age=(\d+)/i.exec(hsts);
      if (maxAge === null || Number(maxAge[1]) < HSTS_MIN_MAX_AGE) {
        issues.push({
          severity: "warning",
          message: `Strict-Transport-Security max-age is below ${String(HSTS_MIN_MAX_AGE)} seconds (180 days).`,
          recommendation: "Raise max-age to at least 15552000 (a year is standard: 31536000).",
        });
      }
    }
  }

  if ((get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    issues.push({
      severity: "error",
      message: "X-Content-Type-Options is missing or not set to nosniff.",
      recommendation: 'Add "X-Content-Type-Options: nosniff" to every response.',
    });
  }

  const csp = get("content-security-policy");
  if (csp === undefined) {
    issues.push({
      severity: "warning",
      message: "Content-Security-Policy header is missing.",
      recommendation:
        "Add a CSP — even a minimal frame-ancestors policy blocks clickjacking; a full policy mitigates XSS.",
    });
  }
  const cspHasFrameAncestors = csp !== undefined && csp.toLowerCase().includes("frame-ancestors");
  if (get("x-frame-options") === undefined && !cspHasFrameAncestors) {
    issues.push({
      severity: "warning",
      message:
        "No clickjacking protection: X-Frame-Options and CSP frame-ancestors are both absent.",
      recommendation: 'Add "X-Frame-Options: DENY" or a CSP frame-ancestors directive.',
    });
  }

  if (get("referrer-policy") === undefined) {
    issues.push({
      severity: "warning",
      message: "Referrer-Policy header is missing.",
      recommendation: 'Add "Referrer-Policy: strict-origin-when-cross-origin".',
    });
  }
  if (get("permissions-policy") === undefined) {
    issues.push({
      severity: "warning",
      message: "Permissions-Policy header is missing.",
      recommendation:
        'Add a Permissions-Policy disabling unused features, e.g. "camera=(), microphone=(), geolocation=()".',
    });
  }

  for (const deprecated of ["x-xss-protection", "public-key-pins"]) {
    if (get(deprecated) !== undefined) {
      issues.push({
        severity: "warning",
        message: `Deprecated security header present: ${deprecated}.`,
        recommendation: "Remove it — deprecated headers add attack surface and no protection.",
      });
    }
  }

  if (get("x-powered-by") !== undefined) {
    issues.push({
      severity: "warning",
      message: "X-Powered-By header leaks implementation details.",
      recommendation: "Remove the X-Powered-By header at the server or framework level.",
    });
  }
  const server = get("server");
  if (server !== undefined && /\/[\d.]+/.test(server)) {
    issues.push({
      severity: "warning",
      message: `Server header leaks a version number: "${server}".`,
      recommendation: "Strip the version from the Server header.",
    });
  }

  return issues;
}

export const securityHeadersCheck: Check = {
  id: "security.headers",
  category: "security",
  description: "OWASP-recommended security headers are present (including on error responses).",
  environments: ["ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const basePage = ctx.pages.get(ctx.baseUrl);
    if (basePage === undefined) {
      ctx.logger.debug("Base page not in crawl store; skipping header analysis");
      return { score: 100, findings: [] };
    }
    const https = new URL(basePage.finalUrl).protocol === "https:";
    const findings: Finding[] = analyzeHeaders(basePage.headers, { https }).map((issue) => ({
      ...issue,
      url: basePage.finalUrl,
    }));

    try {
      const probe = await ctx.fetch(new URL(PROBE_PATH, basePage.finalUrl).href);
      const missingOn404 = PARITY_HEADERS.filter(
        (name) => basePage.headers[name] !== undefined && probe.headers[name] === undefined,
      );
      if (missingOn404.length > 0) {
        findings.push({
          severity: "warning",
          url: probe.url,
          message: `Security headers present on pages but missing on error responses: ${missingOn404.join(", ")}.`,
          recommendation:
            "Configure the server/CDN to send security headers on every response, including 404s and 500s.",
        });
      }
    } catch {
      ctx.logger.debug("404 probe failed; skipping error-response parity check");
    }

    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};
