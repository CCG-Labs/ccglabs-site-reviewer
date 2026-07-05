import type { Check, CheckContext, Finding } from "../../types.js";

const ERROR_COST = 20;
const WARNING_COST = 5;

function notFoundMarker(ctx: CheckContext): string | undefined {
  const raw = ctx.config.checks["functionality.error-pages"]?.options?.["notFoundMarker"];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

export const errorPagesCheck: Check = {
  id: "functionality.error-pages",
  category: "functionality",
  description:
    "Requests for nonexistent URLs return a real 404 (not a soft 200) and a branded 404 page.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    // GET the probe directly so we always have the body for the marker check.
    const probeUrl = new URL(
      `/__site-review-should-404__/${Math.random().toString(36).slice(2)}`,
      ctx.baseUrl,
    ).href;
    const findings: Finding[] = [];
    const marker = notFoundMarker(ctx);

    let status: number;
    let body: string;
    try {
      const response = await ctx.fetch(probeUrl);
      status = response.status;
      body = response.body;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.debug("404 probe failed", { message });
      return {
        score: 95,
        findings: [
          {
            severity: "warning",
            url: probeUrl,
            message: `Could not verify 404 handling: ${message}`,
            recommendation: "Ensure the site is reachable so 404 behavior can be checked.",
          },
        ],
      };
    }

    if (status === 200) {
      findings.push({
        severity: "error",
        url: probeUrl,
        message: "A nonexistent URL returns HTTP 200 (soft 404).",
        recommendation:
          "Return a real 404 status for missing pages — soft 404s let search engines index nothing pages and hide broken links.",
      });
    } else if (status >= 300 && status < 400) {
      findings.push({
        severity: "warning",
        url: probeUrl,
        message: `A nonexistent URL redirects (HTTP ${String(status)}) instead of returning 404.`,
        recommendation: "Return a 404 for missing pages rather than redirecting to the homepage.",
      });
    } else if (status === 404 && marker !== undefined && !body.includes(marker)) {
      findings.push({
        severity: "warning",
        url: probeUrl,
        message: `404 status is correct but the expected branded-404 marker "${marker}" was not found.`,
        recommendation: "Confirm the custom 404 page (with navigation) is served for missing URLs.",
      });
    }

    ctx.logger.debug("Error-page probe", { status, findings: findings.length });
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};
