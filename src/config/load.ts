import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import type { SiteReviewConfig } from "../types.js";

const CANDIDATES = [
  "site-review.config.ts",
  "site-review.config.js",
  "site-review.config.mjs",
  "site-review.config.json",
];

export async function loadConfigFile(
  cwd: string,
  explicitPath?: string,
): Promise<SiteReviewConfig | undefined> {
  let path: string | undefined;
  if (explicitPath !== undefined) {
    path = resolve(cwd, explicitPath);
    if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  } else {
    path = CANDIDATES.map((candidate) => resolve(cwd, candidate)).find((p) => existsSync(p));
  }
  if (path === undefined) return undefined;
  if (path.endsWith(".json")) {
    return JSON.parse(readFileSync(path, "utf8")) as SiteReviewConfig;
  }
  const jiti = createJiti(import.meta.url);
  const loaded = await jiti.import<SiteReviewConfig | { default: SiteReviewConfig }>(path);
  return "default" in loaded ? loaded.default : loaded;
}
