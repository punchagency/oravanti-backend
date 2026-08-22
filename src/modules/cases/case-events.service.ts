import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import { labelFor, type AuditActionName } from "../../lib/audit/actions";
import { recordAccessEvent, recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("case-events.service");

/**
 * The matter activity trail, a view over `audit_events`.
 *
 * `case_events` is gone, along with its `case_event_type` enum. The same
 * cutover as leads: one vocabulary — the `case.*` actions in
 * `lib/audit/actions.ts` — written at the call site, stored in the column,
 * returned by the API.
 *
 * The old table's `case_id` was `onDelete: cascade`, so deleting a matter
 * deleted the record of everything ever done to it. That is precisely the
 * history a legal practice cannot afford to lose, and it is why nothing here
 * carries a foreign key.
 */

/** Every action a matter's trail can carry — the `case.*` slice of the registry. */
export type CaseAuditAction = Extract<AuditActionName, `case.${string}`>;

/** The one case action that is a read: recorded with `category: "access"`. */
const isCaseViewAction = (
  action: CaseAuditAction | "case.viewed",
): action is "case.viewed" => action === "case.viewed";

type LogCaseEventInput = {
  organizationId: string;
  caseId: string;
  /** e.g. `"case.step_approved"`. */
  action: CaseAuditAction | "case.viewed";
  /**
   * One sentence describing what happened, in the vocabulary in force now.
   * Defaults to the registry label. Worth writing properly — it is what a
   * reader sees years later and cannot be regenerated from current code.
   */
  summary?: string;
  /**
   * Null for system-initiated events. A `staff.id`, so it lands in
   * `actor_staff_id`; the actor's user id and display name come from the
   * request context, which is what removed the `actorNameFor()` SELECT this
   * module used to run on every single event.
   */
  actorId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Append one entry to a matter's trail.
 *
 * Binds `entityType: "case"` and routes the one view action through
 * the access writer, so a call site never has to remember either.
 */
export const logCaseEvent = async (data: LogCaseEventInput) => {
  const { action } = data;

  if (isCaseViewAction(action)) {
    await recordAccessEvent({
      action,
      entityId: data.caseId,
      organizationId: data.organizationId,
      summary: data.summary,
      metadata: data.metadata,
      actor: { staffId: data.actorId ?? null },
    });
    return;
  }

  await recordAuditEvent({
    action,
    // "case" for every action, including those the registry files under a
    // nested entity such as `workflow_step`. This signature carries only the
    // case id, so filing a step event under `workflow_step` would give it an
    // entity id pointing at the wrong row. A call site holding the real
    // nested id should use `recordAuditEvent` directly and drop the override.
    entityType: "case",
    entityId: data.caseId,
    organizationId: data.organizationId,
    summary: data.summary,
    metadata: data.metadata,
    actor: { staffId: data.actorId ?? null },
  });

  log.action("case.event_logged", { caseId: data.caseId });
};

/**
 * Records that a matter was opened.
 *
 * The 5-minute deduplication that used to live here — and separately in the
 * lead equivalent, and nowhere else — is now inside `recordAccessEvent`, so
 * every access path gets it.
 */
export const logCaseView = async (
  organizationId: string,
  caseId: string,
  actorId: string | null | undefined,
) => {
  if (!actorId) return;

  await recordAccessEvent({
    action: "case.viewed",
    entityId: caseId,
    organizationId,
    actor: { staffId: actorId },
  });
};

export type CaseActivityEntry = {
  id: string;
  /** A registry action name, e.g. `"case.step_approved"`. */
  action: string;
  /** The registry's label, e.g. `"Step approved"`. */
  label: string;
  /** The sentence written when the row was recorded. */
  summary: string;
  /** `staff.id`, or null for a system event. Render the absence; never guess a name. */
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
};

/**
 * One matter's activity — changes and views together, from one table.
 *
 * A single index scan on
 * `(organization_id, entity_type, entity_id, occurred_at desc)`. This was a
 * `UNION ALL` across two tables with two summed counts until `access_events`
 * was folded into `audit_events`; every entity feed wanted both halves, so
 * the split was being undone on every read.
 */
const caseActivityWhere = (caseId: string, organizationId: string) =>
  and(
    eq(auditEvents.organizationId, organizationId),
    eq(auditEvents.entityType, "case"),
    eq(auditEvents.entityId, caseId),
  );

const caseActivitySelect = (caseId: string, organizationId: string) =>
  db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorStaffId: auditEvents.actorStaffId,
      actorName: auditEvents.actorName,
      summary: auditEvents.summary,
      metadata: auditEvents.metadata,
      ipAddress: auditEvents.ipAddress,
      occurredAt: auditEvents.occurredAt,
    })
    .from(auditEvents)
    .where(caseActivityWhere(caseId, organizationId))
    .orderBy(desc(auditEvents.occurredAt));


type CaseActivityRow = {
  id: string;
  action: string;
  actorStaffId: string | null;
  actorName: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  occurredAt: Date;
};

const toActivityEntry = (r: CaseActivityRow): CaseActivityEntry => ({
  id: r.id,
  action: r.action,
  label: labelFor(r.action),
  summary: r.summary,
  actorId: r.actorStaffId,
  // The snapshot is the only source now. The old read left-joined `staff` to
  // prefer a live name over the stored one, so renaming a staff member
  // silently rewrote history.
  actorName: r.actorName,
  metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  ipAddress: r.ipAddress,
  createdAt: r.occurredAt,
});

export const getCaseActivity = async (
  caseId: string,
  organizationId: string,
): Promise<CaseActivityEntry[]> => {
  const rows = await caseActivitySelect(caseId, organizationId);

  return rows.map(toActivityEntry);
};

const caseActivityCount = (caseId: string, organizationId: string) =>
  db
    .select({ value: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(caseActivityWhere(caseId, organizationId));

/** Paginated view for the audit-log endpoint. */
export const getCaseActivityPaginated = async (params: {
  caseId: string;
  organizationId: string;
  page?: number;
  limit?: number;
}) => {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;

  const [rows, [count]] = await Promise.all([
    caseActivitySelect(params.caseId, params.organizationId)
      .limit(limit)
      .offset(offset),
    caseActivityCount(params.caseId, params.organizationId),
  ]);

  const total = count?.value ?? 0;

  return {
    data: rows.map((r) => ({
      ...toActivityEntry(r),
      createdAt: r.occurredAt.toISOString(),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};
