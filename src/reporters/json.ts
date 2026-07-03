import type { ReviewReport } from "../report/schema.js";

export function renderJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}
