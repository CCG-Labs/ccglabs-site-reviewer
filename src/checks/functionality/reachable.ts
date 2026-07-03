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
    return { score: 100, findings: [] };
  },
};
