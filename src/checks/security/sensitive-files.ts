import type { Check, CheckContext, Finding, FetchResult } from "../../types.js";

const ERROR_COST = 20;
const WARNING_COST = 5;
const MAX_PATHS = 100;

const DEFAULT_PATHS = [
  "/.env",
  "/.git/HEAD",
  "/.git/config",
  "/wp-config.php.bak",
  "/config.php.bak",
  "/backup.sql",
  "/database.sql",
  "/dump.sql",
  "/.DS_Store",
  "/.htaccess",
  "/id_rsa",
  "/.aws/credentials",
  "/phpinfo.php",
];

interface SensitiveFilesOptions {
  paths: string[];
  ignore: string[];
}

function sensitiveFilesOptions(ctx: CheckContext): SensitiveFilesOptions {
  const raw = ctx.config.checks["security.sensitive-files"]?.options;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const replacement = strings(raw?.["paths"]);
  const additional = strings(raw?.["additionalPaths"]);
  const paths = (replacement.length > 0 ? replacement : DEFAULT_PATHS).concat(additional);
  return { paths: paths.slice(0, MAX_PATHS), ignore: strings(raw?.["ignore"]) };
}

const isHtml = (headers: Record<string, string>): boolean =>
  (headers["content-type"] ?? "").includes("text/html");

/**
 * Direct per-URL memoized GET. This check always needs the response body to
 * judge exposure, so createProbeCache's HEAD-first strategy is unsuitable
 * here: it would either double-fetch (falling back to GET on every path) or
 * miss the body entirely on a HEAD-200. A plain GET per unique path is
 * simplest and correct given the short, bounded path list.
 */
function createGetCache(
  fetchFn: CheckContext["fetch"],
): (url: string) => Promise<FetchResult | undefined> {
  const cache = new Map<string, Promise<FetchResult | undefined>>();
  return (url) => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const result = fetchFn(url).catch(() => undefined);
    cache.set(url, result);
    return result;
  };
}

export const sensitiveFilesCheck: Check = {
  id: "security.sensitive-files",
  category: "security",
  description: "Sensitive files (.env, .git, backups) are not publicly accessible.",
  environments: ["ci", "production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const options = sensitiveFilesOptions(ctx);
    const get = createGetCache(ctx.fetch);
    const origin = new URL(ctx.baseUrl).origin;
    const findings: Finding[] = [];

    await Promise.all(
      options.paths
        .filter((path) => !options.ignore.some((pattern) => path.includes(pattern)))
        .map(async (path) => {
          const url = new URL(path, origin).href;
          const result = await get(url);
          // Exposed = 200 with non-empty, non-HTML body (HTML 200 is almost always a catch-all page).
          if (
            result !== undefined &&
            result.status === 200 &&
            result.body.trim() !== "" &&
            !isHtml(result.headers)
          ) {
            findings.push({
              severity: "error",
              url,
              message: `Sensitive file is publicly accessible: ${path} (HTTP 200).`,
              recommendation: `Block public access to ${path} at the server/CDN — it can leak credentials or source.`,
            });
          }
        }),
    );

    ctx.logger.debug("Sensitive-file scan", {
      probed: options.paths.length,
      findings: findings.length,
    });
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};
