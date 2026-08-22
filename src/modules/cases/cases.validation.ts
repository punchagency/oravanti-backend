import { z } from "zod";
import {
  caseCloseReasonEnum,
  casePriorityEnum,
  caseStatusEnum,
} from "../../db/schema/cases";

/**
 * Request schemas for the cases module.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. Enum values are derived from the Drizzle schema, never retyped. Hand-
 *      copied unions drift — the previous status filter accepted three labels
 *      (`pending_review`, `completed`, `cancelled`) that do not exist in the
 *      database enum, and Postgres rejected the query at runtime.
 *
 *   2. Body schemas are `.strict()`. The shared `optionalBody()` helper this
 *      replaces was `z.object({}).passthrough()` — it accepted any object and
 *      handed it straight to `.set({ ...data })`, which meant a request could
 *      write `organizationId` and move a matter to another firm.
 */

export const caseStatus = z.enum(caseStatusEnum.enumValues);
export const casePriority = z.enum(casePriorityEnum.enumValues);
export const caseCloseReason = z.enum(caseCloseReasonEnum.enumValues);

const uuid = z.string().uuid();

/** `YYYY-MM-DD` — matches the `date` columns, which are not timestamps. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format");

const pageNumber = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(20);

// ── Params ───────────────────────────────────────────────────────────────────

export const caseIdParams = z.object({ id: uuid });
export const caseDocumentsParams = z.object({ caseId: uuid });

// ── Queries ──────────────────────────────────────────────────────────────────

export const generateCaseNumberQuery = z.object({
  practiceAreaId: uuid,
  caseType: z.string().trim().min(1, "caseType is required"),
});

export const listCasesQuery = z.object({
  search: z.string().trim().min(1).optional(),
  status: caseStatus.optional(),
  assigneeId: uuid.optional(),
  clientId: uuid.optional(),
  practiceAreaId: uuid.optional(),
  practiceAreaName: z.string().trim().min(1).optional(),
  caseTypeName: z.string().trim().min(1).optional(),
  subcategoryName: z.string().trim().min(1).optional(),
  assigneeName: z.string().trim().min(1).optional(),
  page: pageNumber,
  limit: pageSize,
});

export const paginationQuery = z.object({
  page: pageNumber,
  limit: pageSize,
});

// ── Bodies ───────────────────────────────────────────────────────────────────

export const createCaseBody = z
  .object({
    clientId: uuid,
    practiceAreaId: uuid,
    caseType: z.string().trim().min(1),
    description: z.string().trim().min(1).max(20_000),
    filingDate: isoDate,
    // Optional at creation; the service allocates one when absent.
    caseNumber: z.string().trim().min(1).max(64).optional(),
    priority: casePriority.optional(),
    assignedTeamId: z.string().min(1).optional(),
    estimatedCompletionDate: isoDate.optional(),
    leadId: uuid.optional(),
  })
  .strict();

/**
 * The writable surface of a case, and nothing else.
 *
 * Deliberately absent: `organizationId`, `caseNumber`, `clientId`, `leadId`,
 * `openedById`, `createdAt`. Those are either tenancy, identity, or provenance
 * — none of them belong to a client-supplied patch.
 */
export const updateCaseBody = z
  .object({
    status: caseStatus.optional(),
    priority: casePriority.optional(),
    closeReason: caseCloseReason.optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    practiceAreaId: uuid.optional(),
    caseTypeId: uuid.optional(),
    assignedTeamId: z.string().min(1).nullable().optional(),
    caseProgress: z.number().int().min(0).max(100).optional(),
    billingType: z.enum(["hourly", "flat_fee", "contingency", "pro_bono"]).optional(),
    jurisdiction: z.string().trim().max(200).optional(),
    assignedJudge: z.string().trim().max(200).optional(),
    courtName: z.string().trim().max(200).optional(),
    courtDocketNumber: z.string().trim().max(120).optional(),
    filingDate: isoDate.nullable().optional(),
    estimatedCompletionDate: isoDate.nullable().optional(),
    nextCourtDate: z.coerce.date().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export const reassignTeamBody = z
  .object({ teamId: z.string().min(1) })
  .strict();

// ── Inferred types ───────────────────────────────────────────────────────────
// Services accept these, not `Partial<typeof cases.$inferInsert>` — so passing
// a raw `req.body` is a compile error rather than a tenancy bug.

export type CreateCaseInput = z.infer<typeof createCaseBody>;
export type UpdateCaseInput = z.infer<typeof updateCaseBody>;
export type ListCasesQuery = z.infer<typeof listCasesQuery>;
