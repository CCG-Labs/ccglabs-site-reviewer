import { samplePages } from "../../browser/sample.js";
import type { Check, Finding } from "../../types.js";

interface ConsoleErrorsOptions {
  ignore: string[];
}

export const consoleErrorsCheck: Check = {
  id: "functionality.console-errors",
  category: "functionality",
  description: "Pages load without uncaught JavaScript errors or failed resource requests.",
  environments: ["local", "ci", "production"],
  requires: "browser",
  blocking: true,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const rawIgnore = ctx.config.checks["functionality.console-errors"]?.options?.["ignore"];
    const options: ConsoleErrorsOptions = {
      ignore: Array.isArray(rawIgnore)
        ? rawIgnore.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
    const ignored = (text: string): boolean => options.ignore.some((p) => text.includes(p));

    const targets = samplePages(ctx.pages.all(), ctx.baseUrl, ctx.config.browserSampleSize);
    if (targets.length === 0) return { score: 100, findings: [] };

    const findings: Finding[] = [];
    const pagesWithErrors = new Set<string>();

    for (const target of targets) {
      const page = await browser.newPage();
      const errors: string[] = [];
      const failed: string[] = [];
      page.onError((message) => {
        if (!ignored(message)) errors.push(message);
      });
      page.onRequestFailed((request) => {
        if (!ignored(request.url)) failed.push(request.url);
      });
      try {
        await page.goto(target.url);
      } catch (error) {
        findings.push({
          severity: "warning",
          url: target.url,
          message: `Page could not be loaded in a browser: ${error instanceof Error ? error.message : String(error)}`,
          recommendation: "Re-run; if this persists the page may hang or block automated browsers.",
        });
        await page.close();
        continue;
      }
      await page.close();

      if (errors.length > 0) {
        findings.push({
          severity: "error",
          url: target.url,
          message: `${String(errors.length)} JavaScript error(s): ${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? " | …" : ""}`,
          recommendation:
            "Fix the uncaught errors — they can silently break navigation, forms, or analytics.",
        });
        pagesWithErrors.add(target.url);
      }
      if (failed.length > 0) {
        findings.push({
          severity: "warning",
          url: target.url,
          message: `${String(failed.length)} failed resource request(s): ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", …" : ""}`,
          recommendation:
            "Fix or remove the broken requests (404/blocked assets, mixed content, dead APIs).",
        });
      }
    }

    ctx.logger.debug("Console-error scan", {
      pagesChecked: targets.length,
      findings: findings.length,
    });
    const cleanPages = targets.length - pagesWithErrors.size;
    return { score: Math.round((100 * cleanPages) / targets.length), findings };
  },
};
