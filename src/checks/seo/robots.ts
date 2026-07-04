export interface RobotsTxt {
  /** literal + wildcard Disallow patterns from the `User-agent: *` group */
  wildcardDisallows: string[];
  /** literal + wildcard Allow patterns from the `User-agent: *` group */
  wildcardAllows: string[];
  /** every Sitemap: line, any group */
  sitemaps: string[];
}

/**
 * Minimal robots.txt parser: tracks only the wildcard (*) user-agent group's
 * Disallow/Allow rules plus global Sitemap lines. Group boundaries follow the
 * standard: consecutive User-agent lines share a group; a User-agent line
 * after directives starts a new group.
 */
export function parseRobotsTxt(text: string): RobotsTxt {
  const robots: RobotsTxt = { wildcardDisallows: [], wildcardAllows: [], sitemaps: [] };
  let inWildcardGroup = false;
  let groupHadDirectives = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (groupHadDirectives) {
        inWildcardGroup = false;
        groupHadDirectives = false;
      }
      if (value === "*") inWildcardGroup = true;
    } else if (field === "sitemap") {
      if (value !== "") robots.sitemaps.push(value);
    } else if (field === "disallow" || field === "allow" || field === "crawl-delay") {
      groupHadDirectives = true;
      if (!inWildcardGroup || value === "") continue;
      if (field === "disallow") robots.wildcardDisallows.push(value);
      else if (field === "allow") robots.wildcardAllows.push(value);
    }
  }
  return robots;
}

const isLiteral = (pattern: string): boolean => !pattern.includes("*") && !pattern.endsWith("$");

/**
 * True when the URL's path is blocked for `User-agent: *`. Only literal
 * (wildcard-free) patterns are evaluated, with Google's longest-match
 * precedence between Allow and Disallow; wildcard patterns never match
 * (conservative — no false positives).
 */
export function isDisallowed(url: string, robots: RobotsTxt): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const path = target.pathname + target.search;
  const longest = (patterns: string[]): number =>
    patterns.reduce(
      (best, pattern) =>
        isLiteral(pattern) && path.startsWith(pattern) && pattern.length > best
          ? pattern.length
          : best,
      0,
    );
  const disallow = longest(robots.wildcardDisallows);
  if (disallow === 0) return false;
  return disallow > longest(robots.wildcardAllows);
}
