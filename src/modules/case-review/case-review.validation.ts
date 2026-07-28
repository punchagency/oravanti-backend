import { z } from "zod";

export const listIssuesQuerySchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z
    .enum(["open", "under_review", "resolved", "dismissed", "superseded"])
    .optional(),
  leadId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** Resolution log additionally accepts a lookback window (defaults to 30d). */
export const resolutionLogQuerySchema = paginationQuerySchema.extend({
  days: z.coerce.number().int().positive().max(365).optional(),
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

export const actionParamsSchema = z.object({
  id: z.string().uuid(),
  actionKey: z.string().min(1).max(64),
});

/**
 * Optional because most actions take no assignee, and because a firm with a
 * single attorney has nothing to choose — the service resolves that case.
 */
export const actionBodySchema = z.object({
  assigneeStaffId: z.string().uuid().optional(),
});

export const issueParamsSchema = z.object({ id: z.string().uuid() });

/** Export accepts a format alongside the list/log filters. */
export const exportFormatSchema = z.object({
  format: z.enum(["csv", "pdf"]).optional(),
});

export const exportIssuesQuerySchema = listIssuesQuerySchema.merge(exportFormatSchema);
export const exportResolutionLogQuerySchema =
  resolutionLogQuerySchema.merge(exportFormatSchema);
