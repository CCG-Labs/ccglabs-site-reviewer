import type { Finding } from "../types.js";

export function statusFromFindings(findings: Finding[]): "pass" | "warn" | "fail" {
  if (findings.some((f) => f.severity === "error")) return "fail";
  if (findings.some((f) => f.severity === "warning")) return "warn";
  return "pass";
}

export function categoryScore(
  checks: Array<{ score: number; weight: number; status: string }>,
): number {
  const scorable = checks.filter((check) => check.status !== "error");
  const totalWeight = scorable.reduce((sum, check) => sum + check.weight, 0);
  if (totalWeight === 0) return 100;
  const weighted = scorable.reduce((sum, check) => sum + check.score * check.weight, 0);
  return Math.round(weighted / totalWeight);
}

export function overallScore(categoryScores: number[]): number {
  if (categoryScores.length === 0) return 100;
  return Math.round(categoryScores.reduce((sum, s) => sum + s, 0) / categoryScores.length);
}

export function computeGrade(args: {
  overall: number;
  failThreshold: number;
  anyBlockingFailed: boolean;
}): "pass" | "fail" {
  return args.anyBlockingFailed || args.overall < args.failThreshold ? "fail" : "pass";
}
