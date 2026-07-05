import type { Check, CheckContext, CheckOverride, Environment, Finding } from "../types.js";
import { statusFromFindings } from "./score.js";

export interface ExecutedCheck {
  check: Check;
  status: "pass" | "warn" | "fail" | "error";
  score: number;
  findings: Finding[];
  debug: Array<{ message: string; data?: unknown }>;
}

const BROWSER_EXTRAS_HINT =
  "requires the browser extras — run: npm i -D playwright lighthouse && npx playwright install chromium";

export function partitionChecks(
  checks: Check[],
  environment: Environment,
  overrides: Record<string, CheckOverride>,
  browserAvailable = true,
): { toRun: Check[]; skipped: Array<{ id: string; reason: string }> } {
  const toRun: Check[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const check of checks) {
    if (overrides[check.id]?.enabled === false) {
      skipped.push({ id: check.id, reason: "disabled by config" });
    } else if (check.requires === "browser" && !browserAvailable) {
      skipped.push({ id: check.id, reason: BROWSER_EXTRAS_HINT });
    } else if (!check.environments.includes(environment)) {
      skipped.push({ id: check.id, reason: `not applicable in environment "${environment}"` });
    } else {
      toRun.push(check);
    }
  }
  return { toRun, skipped };
}

export function applyOverride(check: Check, override?: CheckOverride): Check {
  if (!override) return check;
  return {
    ...check,
    blocking: override.blocking ?? check.blocking,
    weight: override.weight ?? check.weight,
  };
}

const clamp = (score: number): number => Math.min(100, Math.max(0, score));

async function withTimeout<T>(promise: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Check "${id}" timed out after ${String(ms)}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(
  checks: Check[],
  base: Omit<CheckContext, "logger">,
  timeoutMs = 60_000,
): Promise<ExecutedCheck[]> {
  return Promise.all(
    checks.map(async (check): Promise<ExecutedCheck> => {
      const debug: Array<{ message: string; data?: unknown }> = [];
      const ctx: CheckContext = {
        ...base,
        logger: {
          debug(message, data) {
            debug.push(data === undefined ? { message } : { message, data });
          },
        },
      };
      try {
        const outcome = await withTimeout(check.run(ctx), timeoutMs, check.id);
        return {
          check,
          status: statusFromFindings(outcome.findings),
          score: clamp(outcome.score),
          findings: outcome.findings,
          debug,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          check,
          status: "error",
          score: 0,
          findings: [
            {
              severity: "error",
              message: `Check crashed: ${message}`,
              recommendation:
                "This is a tool defect, not a site defect. Report it as a bug on @ccglabs/site-reviewer.",
            },
          ],
          debug,
        };
      }
    }),
  );
}
