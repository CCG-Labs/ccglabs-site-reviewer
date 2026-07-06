import type { LighthouseRun } from "../../browser/types.js";
import type { Check, CheckContext, Finding } from "../../types.js";

const LAB_CAVEAT =
  "Lab data from an automated run — verify against field data (CrUX) before optimizing.";

/** Lighthouse's own green band: below this a category draws an advisory warning. */
const DEFAULT_MIN_SCORE = 90;

type CategoryKey = keyof LighthouseRun["categories"];
type MetricKey = keyof LighthouseRun["metrics"];

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  bestPractices: "Best Practices",
  seo: "SEO",
};

/** Google's "good" thresholds; TBT stands in for INP in lab data. */
const METRIC_DEFAULTS: Record<
  MetricKey,
  { max: number; label: string; format: (v: number) => string }
> = {
  lcpMs: { max: 2500, label: "LCP", format: (v) => `${String(Math.round(v))} ms` },
  cls: { max: 0.1, label: "CLS", format: (v) => v.toFixed(3) },
  tbtMs: { max: 200, label: "TBT (INP lab proxy)", format: (v) => `${String(Math.round(v))} ms` },
};

interface LighthouseOptions {
  urls: string[];
  runs: number;
  minScores: Partial<Record<CategoryKey, number>>;
  maxMetrics: Partial<Record<MetricKey, number>>;
}

function lighthouseOptions(ctx: CheckContext): LighthouseOptions {
  const raw = ctx.config.checks["performance.lighthouse"]?.options;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const numRecord = <K extends string>(
    value: unknown,
    keys: readonly K[],
  ): Partial<Record<K, number>> => {
    const out: Partial<Record<K, number>> = {};
    if (typeof value !== "object" || value === null) return out;
    for (const key of keys) {
      const entry = num((value as Record<string, unknown>)[key]);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  };
  const urls = Array.isArray(raw?.["urls"])
    ? raw["urls"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    urls,
    runs: Math.max(1, Math.round(num(raw?.["runs"]) ?? 1)),
    minScores: numRecord(raw?.["minScores"], [
      "performance",
      "accessibility",
      "bestPractices",
      "seo",
    ]),
    maxMetrics: numRecord(raw?.["maxMetrics"], ["lcpMs", "cls", "tbtMs"]),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Combine N runs into one: median per numeric field; available iff every run was. */
function combineRuns(runs: LighthouseRun[]): LighthouseRun {
  const first = runs[0];
  if (runs.length === 1 && first !== undefined) return first;
  const pick = (select: (run: LighthouseRun) => number | null): number | null =>
    median(runs.map(select).filter((v): v is number => v !== null));
  return {
    available: runs.every((run) => run.available),
    categories: {
      performance: pick((r) => r.categories.performance),
      accessibility: pick((r) => r.categories.accessibility),
      bestPractices: pick((r) => r.categories.bestPractices),
      seo: pick((r) => r.categories.seo),
    },
    metrics: {
      lcpMs: pick((r) => r.metrics.lcpMs),
      cls: pick((r) => r.metrics.cls),
      tbtMs: pick((r) => r.metrics.tbtMs),
    },
  };
}

export const lighthouseCheck: Check = {
  id: "performance.lighthouse",
  category: "performance",
  description:
    "Lighthouse category scores and Core Web Vitals (lab data). Advisory warnings by default; configure minScores/maxMetrics budgets to enforce as errors.",
  environments: ["ci", "production"],
  requires: "browser",
  blocking: false,
  weight: 1,
  async run(ctx) {
    const browser = ctx.browser;
    if (browser === undefined) return { score: 100, findings: [] };

    const options = lighthouseOptions(ctx);
    const targets = [ctx.baseUrl, ...options.urls.filter((url) => url !== ctx.baseUrl)];
    const findings: Finding[] = [];

    for (const url of targets) {
      let run: LighthouseRun;
      try {
        const runs: LighthouseRun[] = [];
        for (let i = 0; i < options.runs; i++) runs.push(await browser.runLighthouse(url));
        run = combineRuns(runs);
      } catch (error) {
        findings.push({
          severity: "warning",
          url,
          message: `The Lighthouse audit could not complete on ${url}: ${error instanceof Error ? error.message : String(error)}`,
          recommendation:
            "This is likely a transient page condition — re-run, or investigate if persistent.",
        });
        continue;
      }

      if (!run.available) {
        return {
          score: 100,
          findings: [
            {
              severity: "warning",
              url: ctx.baseUrl,
              message: "lighthouse is not installed, so the performance audit did not run.",
              recommendation: "Run: npm i -D lighthouse to enable the performance audit.",
            },
          ],
        };
      }

      for (const key of Object.keys(CATEGORY_LABELS) as CategoryKey[]) {
        const score = run.categories[key];
        if (score === null) continue;
        const budget = options.minScores[key];
        if (budget !== undefined) {
          if (score < budget) {
            findings.push({
              severity: "error",
              url,
              message: `Lighthouse ${CATEGORY_LABELS[key]} score ${String(score)} is below the configured budget of ${String(budget)}. ${LAB_CAVEAT}`,
              recommendation: `Investigate the Lighthouse ${CATEGORY_LABELS[key]} audit details, or adjust the minScores budget.`,
            });
          }
        } else if (score < DEFAULT_MIN_SCORE) {
          findings.push({
            severity: "warning",
            url,
            message: `Lighthouse ${CATEGORY_LABELS[key]} score is ${String(score)} (below ${String(DEFAULT_MIN_SCORE)}). ${LAB_CAVEAT}`,
            recommendation:
              "Advisory only. Set an explicit minScores budget ~10-20% above today's score and ratchet it over time.",
          });
        }
      }

      for (const key of Object.keys(METRIC_DEFAULTS) as MetricKey[]) {
        const value = run.metrics[key];
        if (value === null) continue;
        const spec = METRIC_DEFAULTS[key];
        const budget = options.maxMetrics[key];
        if (budget !== undefined) {
          if (value > budget) {
            findings.push({
              severity: "error",
              url,
              message: `${spec.label} is ${spec.format(value)}, over the configured budget of ${spec.format(budget)}. ${LAB_CAVEAT}`,
              recommendation: `Optimize ${spec.label}, or adjust the maxMetrics budget.`,
            });
          }
        } else if (value > spec.max) {
          findings.push({
            severity: "warning",
            url,
            message: `${spec.label} is ${spec.format(value)}, over the "good" threshold of ${spec.format(spec.max)}. ${LAB_CAVEAT}`,
            recommendation:
              "Advisory only. Set an explicit maxMetrics budget ~10-20% above today's value and ratchet it over time.",
          });
        }
      }

      ctx.logger.debug("Lighthouse audit", {
        url,
        categories: run.categories,
        metrics: run.metrics,
      });
    }

    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    return { score: Math.max(0, 100 - 20 * errors - 5 * warnings), findings };
  },
};
