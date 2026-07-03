import { z } from "zod";

export const REPORT_VERSION = 2;

export const findingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  recommendation: z.string(),
  url: z.string().optional(),
  details: z.unknown().optional(),
});

export const debugEntrySchema = z.object({
  message: z.string(),
  data: z.unknown().optional(),
});

export const checkReportSchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "warn", "fail", "error"]),
  score: z.number().min(0).max(100),
  blocking: z.boolean(),
  findings: z.array(findingSchema),
  debug: z.array(debugEntrySchema),
});

export const crawlStatsSchema = z.object({
  pagesDiscovered: z.number().int().min(0),
  pagesScanned: z.number().int().min(0),
  capped: z.boolean(),
});

export const categoryReportSchema = z.object({
  id: z.enum([
    "functionality",
    "performance",
    "accessibility",
    "seo",
    "security",
    "content",
    "operations",
  ]),
  score: z.number().min(0).max(100),
  checks: z.array(checkReportSchema),
});

export const reviewReportSchema = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  tool: z.object({ name: z.string(), version: z.string() }),
  target: z.string(),
  environment: z.enum(["local", "ci", "production"]),
  startedAt: z.string(),
  durationMs: z.number(),
  crawl: crawlStatsSchema,
  grade: z.enum(["pass", "fail"]),
  score: z.number().min(0).max(100),
  categories: z.array(categoryReportSchema),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  manualChecklist: z.array(z.string()),
});

export type ReviewReport = z.infer<typeof reviewReportSchema>;
export type CategoryReport = z.infer<typeof categoryReportSchema>;
export type CheckReport = z.infer<typeof checkReportSchema>;
