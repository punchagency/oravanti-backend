import { z } from "zod";

export const exportFormatSchema = z.object({
  format: z.enum(["csv", "pdf"]).optional(),
});

export const invoiceParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listInvoicesQuerySchema = z.object({
  status: z
    .enum(["all", "draft", "paid", "unpaid", "partial", "overdue", "refunded", "void"])
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
  /**
   * Also return the entries this draft already holds.
   *
   * Without it an edit could only ever drop time entries: they carry
   * `invoicedAt` the moment they are attached, which is exactly what excludes
   * them from "unbilled".
   */
  forInvoiceId: z.string().uuid().optional(),
});

export const caseDefaultsQuerySchema = z.object({
  caseId: z.string().uuid(),
});

/**
 * One dated slice of the invoice total.
 *
 * `sequence` is deliberately not accepted: the server sorts by date and
 * renumbers, so a client-supplied ordering could only ever disagree with the one
 * the allocation actually walks.
 */
const instalmentSchema = z.object({
  dueDate: z.string().date(),
  amount: z.coerce.number().positive(),
});

/** 120 matches the fee-agreement wizard's cap on an instalment plan. */
const instalmentsSchema = z.array(instalmentSchema).min(1).max(120);

export const setScheduleBodySchema = z.object({
  instalments: instalmentsSchema,
});

const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.coerce.number().positive().default(1),
  rate: z.coerce.number().nonnegative(),
  account: z.enum(["operating", "trust_iolta"]).default("operating"),
  /**
   * Fee or cost — a different axis from `account`, and optional because most
   * callers have no basis to say. Omitting it on any line of an invoice leaves
   * that invoice on the trust-first split, which is the safe default.
   */
  category: z.enum(["fee", "cost"]).optional(),
  /**
   * Which catalog preset this line was composed from. Provenance only — the
   * billed figures are the three fields above, and the server never reads the
   * preset to fill them in. A stale or unknown id would therefore change
   * nothing about what the client is charged.
   */
  presetId: z.string().uuid().optional(),
});

// ── Line preset catalog ──────────────────────────────────────────────────────

/**
 * Scope for the picker. Both ids optional: an invoice with no matter still
 * gets the unscoped tier, which is the general charges any matter attracts.
 */
export const listLinePresetsQuerySchema = z.object({
  practiceAreaId: z.string().uuid().optional(),
  caseTypeId: z.string().uuid().optional(),
  account: z.enum(["operating", "trust_iolta"]).optional(),
});

export const createLinePresetBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  note: z.string().trim().max(500).optional(),
  account: z.enum(["operating", "trust_iolta"]),
  defaultRate: z.coerce.number().nonnegative(),
  practiceAreaId: z.string().uuid().optional(),
  caseTypeId: z.string().uuid().optional(),
});

export const createInvoiceBodySchema = z
  .object({
    /**
     * Exactly one of `clientId` / `leadId`, matched by the check constraint on
     * the table. A lead is billed during intake — consultation fees and fee
     * agreements are charged before a client record exists at all.
     */
    clientId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
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
    /** Optional payment schedule; the service checks it sums to the total. */
    instalments: instalmentsSchema.optional(),
  })
  .refine((v) => (v.clientId != null) !== (v.leadId != null), {
    message: "An invoice bills either a client or a lead, not both and not neither",
    path: ["clientId"],
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

/**
 * Header fields apply to any live invoice; the content fields below are refused
 * on anything but a draft, in the service (only it can see the stored status).
 *
 * `attorneyId` is nullable so "Unassigned" can actually unassign — an omitted
 * key means "leave alone", which is not the same thing.
 */
export const updateInvoiceBodySchema = z
  .object({
    dueDate: z.string().date().optional(),
    notes: z.string().trim().max(4000).optional(),
    attorneyId: z.string().uuid().nullable().optional(),
    filingType: z.string().trim().max(100).optional(),
    // ── Draft-only, below ────────────────────────────────────────────────────
    issueDate: z.string().date().optional(),
    caseId: z.string().uuid().nullable().optional(),
    practiceAreaId: z.string().uuid().nullable().optional(),
    lineItems: z.array(lineItemSchema).optional(),
    timeEntryIds: z.array(z.string().uuid()).optional(),
    /**
     * Replaces the whole schedule. The one content field allowed on a sent
     * invoice — a renegotiated plan is the point of offering one, and the
     * revision is recorded as its own event.
     */
    instalments: instalmentsSchema.optional(),
  })
  // A content edit REPLACES the whole line set, so a payload carrying only one
  // half of it would silently delete the other. Demanding both makes the client
  // state what the invoice should end up containing.
  .refine(
    (v) =>
      (v.lineItems === undefined) === (v.timeEntryIds === undefined),
    {
      message:
        "Send lineItems and timeEntryIds together — editing lines replaces the whole set",
      path: ["lineItems"],
    },
  )
  .refine(
    (v) =>
      v.lineItems === undefined ||
      v.lineItems.length > 0 ||
      (v.timeEntryIds?.length ?? 0) > 0,
    {
      message: "An invoice needs at least one line item or time entry",
      path: ["lineItems"],
    },
  );

export const voidInvoiceBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * Give a client longer to pay.
 *
 * "Later than the current due date" cannot be checked here — the current one is
 * in the database — so the service enforces it. This only guarantees a
 * well-formed date arrives.
 */
export const extendDueDateBodySchema = z.object({
  dueDate: z.string().date(),
  reason: z.string().trim().max(500).optional(),
});

/** Which payment on the invoice, for the refund route. */
export const paymentParamsSchema = z.object({
  id: z.string().uuid(),
  paymentId: z.string().uuid(),
});

/**
 * Refunding a payment.
 *
 * `amount` omitted means the whole payment, which is the case that can execute
 * as a void. A partial can only be a refund, and Confido accepts one only after
 * the payment has settled.
 */
export const refundPaymentBodySchema = z.object({
  amount: z.coerce.number().positive().optional(),
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
