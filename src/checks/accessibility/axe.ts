import { samplePages } from "../../browser/sample.js";
import type { AxeViolation } from "../../browser/types.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const DEFAULT_STANDARD = ["wcag2a", "wcag2aa"];

interface AxeOptions {
  standard: string[];
  ignore: string[];
}

function axeOptions(ctx: CheckContext): AxeOptions {
  const raw = ctx.config.checks["accessibility.axe"]?.options;
  const strings = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : fallback;
  return {
    standard: strings(raw?.["standard"], DEFAULT_STANDARD),
    ignore: strings(raw?.["ignore"], []),
  };
}

function severityFor(impact: AxeViolation["impact"]): Finding["severity"] {
  if (impact === "critical" || impact === "serious") return "error";
  if (impact === "moderate") return "warning";
  return "info";
}

export const axeCheck: Check = {
  id: "accessibility.axe",
  category: "accessibility",
  description:
    "Automated axe-core WCAG scan (catches ~30–50% of issues; not a substitute for manual/screen-reader testing).",
  environments: ["local", "ci", "production"],
  requires: "browser",
  blocking: false,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const targets = samplePages(ctx.pages.all(), ctx.baseUrl, ctx.config.browserSampleSize);
    if (targets.length === 0) return { score: 100, findings: [] };

    const options = axeOptions(ctx);
    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();

    for (const target of targets) {
      const page = await browser.newPage();
      try {
        await page.goto(target.url);
      } catch (error) {
        findings.push({
          severity: "warning",
          url: target.url,
          message: `Page could not be loaded for the accessibility scan: ${error instanceof Error ? error.message : String(error)}`,
          recommendation: "Re-run; if this persists the page may hang or block automated browsers.",
        });
        await page.close();
        continue;
      }
      const run = await page.runAxe({ standard: options.standard, ignore: options.ignore });
      await page.close();

      if (!run.available) {
        return {
          score: 100,
          findings: [
            {
              severity: "warning",
              url: ctx.baseUrl,
              message: "axe-core is not installed, so the accessibility scan did not run.",
              recommendation:
                "Run: npm i -D @axe-core/playwright to enable the accessibility scan.",
            },
          ],
        };
      }

      for (const violation of run.violations) {
        const severity = severityFor(violation.impact);
        findings.push({
          severity,
          url: target.url,
          message: `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help} — ${String(violation.nodeCount)} element(s).`,
          recommendation:
            "Fix the flagged elements; see the axe rule reference at https://dequeuniversity.com/rules/axe.",
        });
        if (severity === "error") pagesWithErrors.add(target.url);
      }
    }

    ctx.logger.debug("Accessibility scan", {
      pagesChecked: targets.length,
      findings: findings.length,
    });
    const cleanPages = targets.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / targets.length), findings };
  },
};
