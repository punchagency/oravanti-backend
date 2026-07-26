import { z } from "zod";

export const listIssuesQuerySchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z
    .enum(["open", "under_review", "resolved", "dismissed", "superseded"])
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const updateStatusBodySchema = z.object({
  action: z.enum(["resolve", "dismiss", "reopen", "review"]),
  note: z.string().max(2000).optional(),
});

export const updateConfigBodySchema = z
  .object({
    isActive: z.boolean().optional(),
    crossCheckingEnabled: z.boolean().optional(),
    photoComparisonEnabled: z.boolean().optional(),
    realtimeAnalysis: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one setting is required",
  });
