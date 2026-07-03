import type { Check } from "../../types.js";

export const reachableCheck: Check = {
  id: "functionality.reachable",
  category: "functionality",
  description: "The base URL responds with a successful status code.",
  environments: ["local", "ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const result = await ctx.fetch(ctx.baseUrl);
    ctx.logger.debug("Fetched base URL", {
      status: result.status,
      finalUrl: result.url,
      durationMs: result.durationMs,
    });
    if (result.status >= 400) {
      return {
        score: 0,
        findings: [
          {
            severity: "error",
            url: ctx.baseUrl,
            message: `Base URL returned HTTP ${String(result.status)}.`,
            recommendation:
              "Ensure the site is deployed, the server is healthy, and the URL (including scheme and path) is correct.",
          },
        ],
      };
    }
    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.location;
      const target = location !== undefined ? ` to ${location}` : "";
      return {
        score: 0,
        findings: [
          {
            severity: "error",
            url: ctx.baseUrl,
            message: `Base URL redirects off-origin${target} and was not followed.`,
            recommendation:
              "Point site-review at the canonical URL (following the redirect) instead of the redirecting one.",
          },
        ],
      };
    }
    return { score: 100, findings: [] };
  },
};
