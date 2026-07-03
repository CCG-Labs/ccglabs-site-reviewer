import type { ReviewReport } from "../report/schema.js";

export function renderConsole(report: ReviewReport): string {
  const lines: string[] = [
    `Site review: ${report.target}`,
    `Environment: ${report.environment}   Grade: ${report.grade.toUpperCase()}   Score: ${String(report.score)}/100`,
    "",
  ];
  for (const category of report.categories) {
    lines.push(`${category.id}: ${String(category.score)}/100`);
    for (const check of category.checks) {
      lines.push(`  [${check.status}] ${check.id}`);
      for (const finding of check.findings) {
        const location = finding.url === undefined ? "" : ` (${finding.url})`;
        lines.push(`    ${finding.severity}: ${finding.message}${location}`);
        lines.push(`      fix: ${finding.recommendation}`);
      }
    }
  }
  if (report.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const skip of report.skipped) {
      lines.push(`  ${skip.id} — ${skip.reason}`);
    }
  }
  lines.push("", "Manual sign-off still required:");
  for (const item of report.manualChecklist) {
    lines.push(`  [ ] ${item}`);
  }
  return lines.join("\n");
}
