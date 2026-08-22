import { z } from "zod";

/**
 * `action` and `domain` are validated as shapes, not against the registry.
 *
 * A filter for an action this deployment has never heard of should return no
 * rows, not a 400 — the caller may be a slightly older or newer frontend, and
 * refusing the request tells them nothing useful. The write path is where the
 * registry is enforced, and it is enforced there by the type system.
 */
const actionName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "Not an action name");

const domainName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "Not a domain name")
  .max(40);

/**
 * The filters, with no refinement attached.
 *
 * Kept separate from the exported schemas because **zod v4 refuses `.omit()` on
 * an object that carries a refinement** — it throws at module load, not at
 * validation time, and `tsc` does not see it because the method exists on the
 * type. Derive the shapes first, refine last, and the export schema can drop
 * the two fields it has no use for.
 */
const auditFilterShape = z.object({
  category: z
    .enum(["business", "security", "admin", "system", "access"])
    .optional(),
  action: actionName.optional(),
  domain: domainName.optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(128).optional(),
  actorId: z.string().min(1).max(128).optional(),
  actorStaffId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** An inverted range returns nothing, so say so rather than answering emptily. */
const orderedDateRange = {
  check: (v: { from?: Date; to?: Date }) => !v.from || !v.to || v.from <= v.to,
  message: "`from` must not be after `to`",
  path: ["from"] as const,
};

export const listAuditEventsQuerySchema = auditFilterShape.refine(
  orderedDateRange.check,
  { message: orderedDateRange.message, path: [...orderedDateRange.path] },
);

/**
 * An export has no paging — it is the whole filtered set in one file —
 * because the service caps it at 10,000 rows.
 */
export const exportAuditEventsQuerySchema = auditFilterShape
  .omit({ page: true, limit: true })
  .extend({ format: z.enum(["csv", "pdf"]).default("csv") })
  .refine(orderedDateRange.check, {
    message: orderedDateRange.message,
    path: [...orderedDateRange.path],
  });

export const entityFeedParamsSchema = z.object({
  entityType: z.string().min(1).max(64),
  entityId: z.string().min(1).max(128),
});

export const entityFeedQuerySchema = z.object({
  category: z
    .enum(["business", "security", "admin", "system", "access"])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

export const requestIdParamsSchema = z.object({
  requestId: z.string().min(1).max(128),
});
