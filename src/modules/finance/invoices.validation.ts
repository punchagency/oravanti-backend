import { z } from "zod";

export const exportFormatSchema = z.object({
  format: z.enum(["csv", "pdf"]).optional(),
});

export const invoiceParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listInvoicesQuerySchema = z.object({
  status: z
    .enum(["all", "draft", "paid", "unpaid", "partial", "overdue"])
    .optional(),
  account: z.enum(["all", "operating", "trust"]).optional(),
  search: z.string().trim().max(200).optional(),
  clientId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  /**
   * Show drafts alongside everything else. Only meaningful with status "all" —
   * the other buckets already name a specific non-draft state.
   *
   * Deliberately not z.coerce.boolean(), which maps the string "false" to true.
   */
  includeDrafts: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const exportInvoicesQuerySchema = listInvoicesQuerySchema.extend(
  exportFormatSchema.shape,
);

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

export const unbilledTimeQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
});

const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.coerce.number().positive().default(1),
  rate: z.coerce.number().nonnegative(),
  account: z.enum(["operating", "trust_iolta"]).default("operating"),
});

export const createInvoiceBodySchema = z
  .object({
    clientId: z.string().uuid(),
    caseId: z.string().uuid().optional(),
    practiceAreaId: z.string().uuid().optional(),
    attorneyId: z.string().uuid().optional(),
    filingType: z.string().trim().max(100).optional(),
    issueDate: z.string().date(),
    dueDate: z.string().date(),
    notes: z.string().trim().max(4000).optional(),
    // Draft by default. An invoice becomes `sent` only when a delivery
    // actually succeeds — see deliveries.service.ts.
    status: z.enum(["draft"]).default("draft"),
    lineItems: z.array(lineItemSchema).default([]),
    /** Approved, unbilled entries to convert into lines. */
    timeEntryIds: z.array(z.string().uuid()).default([]),
  })
  .refine((v) => v.lineItems.length > 0 || v.timeEntryIds.length > 0, {
    message: "An invoice needs at least one line item or time entry",
    path: ["lineItems"],
  })
  // Without one or the other, the revenue-by-practice-area report silently
  // undercounts this invoice.
  .refine((v) => v.caseId != null || v.practiceAreaId != null, {
    message: "A practice area is required when the invoice has no matter",
    path: ["practiceAreaId"],
  })
  .refine((v) => v.dueDate >= v.issueDate, {
    message: "Due date cannot precede the issue date",
    path: ["dueDate"],
  });

export const updateInvoiceBodySchema = z.object({
  dueDate: z.string().date().optional(),
  notes: z.string().trim().max(4000).optional(),
  attorneyId: z.string().uuid().optional(),
  filingType: z.string().trim().max(100).optional(),
});

export const voidInvoiceBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const recordPaymentBodySchema = z
  .object({
    amount: z.coerce.number().positive(),
    /** Optional explicit split; the service pro-rates when absent. */
    amountOperating: z.coerce.number().nonnegative().optional(),
    amountTrust: z.coerce.number().nonnegative().optional(),
    paymentDate: z.string().date(),
    method: z.enum([
      "credit_card",
      "bank_transfer",
      "check",
      "cash",
      "wire",
      "other",
    ]),
    reference: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine(
    (v) =>
      v.amountOperating == null ||
      v.amountTrust == null ||
      Math.abs(v.amountOperating + v.amountTrust - v.amount) < 0.005,
    {
      message: "Operating and trust amounts must sum to the payment amount",
      path: ["amountTrust"],
    },
  );

export const followUpBodySchema = z.object({
  message: z.string().trim().min(1).max(2000),
  channel: z.enum(["email", "sms", "both"]),
});
