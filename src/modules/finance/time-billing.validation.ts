import { z } from "zod";
import { exportFormatSchema } from "./invoices.validation";

export const periodQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

export const timeEntryParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listTimeEntriesQuerySchema = periodQuerySchema.extend({
  status: z.enum(["all", "pending", "approved"]).optional(),
  staffId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const exportTimeEntriesQuerySchema = listTimeEntriesQuerySchema.extend(
  exportFormatSchema.shape,
);

export const topMattersQuerySchema = periodQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(20).optional(),
});

export const createTimeEntryBodySchema = z.object({
  /** Defaults to the caller; logging for someone else needs approve_time. */
  staffId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  entryDate: z.string().date(),
  hoursWorked: z.coerce.number().positive().max(24),
  description: z.string().trim().max(2000).optional(),
  billable: z.boolean().default(true),
});

export const updateTimeEntryBodySchema = z.object({
  caseId: z.string().uuid().optional(),
  entryDate: z.string().date().optional(),
  hoursWorked: z.coerce.number().positive().max(24).optional(),
  description: z.string().trim().max(2000).optional(),
  billable: z.boolean().optional(),
});

export const rejectTimeEntryBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const setBillingRateBodySchema = z
  .object({
    staffId: z.string().uuid().optional(),
    role: z.enum(["admin", "attorney", "paralegal"]).optional(),
    rate: z.coerce.number().nonnegative(),
    effectiveFrom: z.string().date(),
  })
  .refine((v) => (v.staffId != null) !== (v.role != null), {
    message: "A rate must target either a staff member or a role, not both",
    path: ["staffId"],
  });

export const reportQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")
    .optional(),
});

export const exportReportQuerySchema = reportQuerySchema.extend(
  exportFormatSchema.shape,
);
