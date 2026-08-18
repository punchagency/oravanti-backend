import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import { createModuleLogger } from "../../lib/logging/log";
import { labelFor, type AuditActionName } from "../../lib/audit/actions";
import { recordAccessEvent, recordAuditEvent } from "../shared/audit.service";

const log = createModuleLogger("lead-events.service");

/**
 * The lead activity trail, a view over `audit_events`.
 *
 * `lead_events` is gone, and so is its vocabulary. There is one set of names
 * now — the actions in `lib/audit/actions.ts` — and it is the same set stored
 * in the database, returned by the API, and rendered by the frontend. The old
 * table had three spellings of the same event: `stage_changed` in the column,
 * `STAGE_CHANGED` on the wire (via `AUDIT_EVENT_TYPE_MAP`), and "Stage
 * changed" in a frontend map that had drifted into two divergent copies.
 *
 * What the move also buys: a `requestId` on every row tying it to the request
 * that caused it, an actor resolved once per request instead of a SELECT per
 * event, an org-wide index, and survival — `lead_events.lead_id` was
 * `onDelete: cascade`, so deleting a lead deleted the record of everything
 * ever done to it.
 */

/**
 * Every action a lead's trail can carry — the `lead.*` slice of the registry.
 *
 * Call sites name the action directly. There is no translation layer between
 * what you write and what is stored: type `action: "lead."` and autocomplete
 * lists exactly these, and a name the registry does not define will not
 * compile.
 */
export type LeadAuditAction = Extract<AuditActionName, `lead.${string}`>;

/** The one lead action that is a read: recorded with `category: "access"`. */
const isLeadViewAction = (
  action: LeadAuditAction | "lead.viewed",
): action is "lead.viewed" => action === "lead.viewed";

type LogLeadEventInput = {
  organizationId: string;
  leadId: string;
  /** e.g. `"lead.stage_changed"`. */
  action: LeadAuditAction | "lead.viewed";
  /**
   * Null for lead-driven and system events — a lead paying through the booking
   * link, a Dropbox Sign webhook firing. Never invent a staff member for these.
   *
   * This is a `staff.id`, so it lands in `actor_staff_id`. The actor's `user.id`
   * and display name come from the request context, which is what removed the
   * `actorNameFor()` SELECT that used to run on every single event.
   */
  actorId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Append one entry to a lead's trail.
 *
 * A thin wrapper over `recordAuditEvent` that binds `entityType: "lead"` and
 * routes the one view action through the access writer, so a call site never has to
 * remember either. Everything else — actor, tenant, IP, request id — the
 * writer reads from the request context.
 */
export const logLeadEvent = async (data: LogLeadEventInput) => {
  const { action } = data;

  if (isLeadViewAction(action)) {
    await recordAccessEvent({
      action,
      entityId: data.leadId,
      organizationId: data.organizationId,
      metadata: data.metadata,
      actor: { staffId: data.actorId ?? null },
    });
    return;
  }

  await recordAuditEvent({
    action,
    // "lead" for every action, including the ones the registry files under a
    // nested entity such as `lead_note`. This signature only carries the lead
    // id, so filing a note event under `lead_note` would give it an entity id
    // pointing at the wrong row. A call site with the real nested id should
    // use `recordAuditEvent` directly and drop the override.
    entityType: "lead",
    entityId: data.leadId,
    organizationId: data.organizationId,
    metadata: data.metadata,
    actor: { staffId: data.actorId ?? null },
  });

  log.action("lead_event.logged", { action, leadId: data.leadId });
};

/**
 * Records that a lead was opened.
 *
 * The 5-minute deduplication that used to live here is now inside
 * `recordAccessEvent`, so every access path gets it rather than only the two
 * that remembered to implement it.
 */
export const logLeadView = async (
  organizationId: string,
  leadId: string,
  actorId: string | null | undefined,
  tab?: string,
) => {
  if (!actorId) return;

  await recordAccessEvent({
    action: "lead.viewed",
    entityId: leadId,
    organizationId,
    metadata: tab ? { tab } : undefined,
    actor: { staffId: actorId },
  });
};

export type LeadActivityEntry = {
  id: string;
  /** A registry action name, e.g. `"lead.stage_changed"`. */
  action: string;
  /** The registry's label for that action, e.g. `"Stage changed"`. */
  label: string;
  /** One sentence describing what happened, written when the row was recorded. */
  summary: string;
  /** `staff.id`, or null for a system or lead-driven event. Render the absence; never guess a name. */
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
};

/**
 * One lead's activity — changes and views together, from one table.
 *
 * A single index scan on
 * `(organization_id, entity_type, entity_id, occurred_at desc)`. This was a
 * `UNION ALL` across two tables with two summed counts until `access_events`
 * was folded into `audit_events`; every entity feed wanted both halves, so
 * the split was being undone on every read.
 */
const leadActivityWhere = (leadId: string, organizationId: string) =>
  and(
    eq(auditEvents.organizationId, organizationId),
    eq(auditEvents.entityType, "lead"),
    eq(auditEvents.entityId, leadId),
  );

const leadActivitySelect = (leadId: string, organizationId: string) =>
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
    .where(leadActivityWhere(leadId, organizationId))
    .orderBy(desc(auditEvents.occurredAt));


type LeadActivityRow = {
  id: string;
  action: string;
  actorStaffId: string | null;
  actorName: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  occurredAt: Date;
};

const toActivityEntry = (r: LeadActivityRow): LeadActivityEntry => ({
  id: r.id,
  action: r.action,
  label: labelFor(r.action),
  summary: r.summary,
  actorId: r.actorStaffId,
  // The snapshot is the only source now. The old read left-joined `staff` to
  // prefer a live name over the stored one, which meant renaming a staff
  // member silently rewrote history — the trail then said the new name had
  // done things the old name did.
  actorName: r.actorName,
  metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  ipAddress: r.ipAddress,
  createdAt: r.occurredAt,
});

export const getLeadActivity = async (
  leadId: string,
  organizationId: string,
): Promise<LeadActivityEntry[]> => {
  const rows = await leadActivitySelect(leadId, organizationId);

  return rows.map(toActivityEntry);
};

const leadActivityCount = (leadId: string, organizationId: string) =>
  db
    .select({ value: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(leadActivityWhere(leadId, organizationId));

/**
 * The audit-log tab's read: the same rows, paginated.
 *
 * Pagination happens in the database. The previous implementation fetched
 * every event for the lead and called `rows.slice()`, so page 1 of a lead with
 * ten thousand events cost exactly as much as page 500.
 */
export const getLeadAuditLog = async (
  leadId: string,
  organizationId: string,
  page = 1,
  limit = 20,
) => {
  const offset = (page - 1) * limit;

  const [rows, [count]] = await Promise.all([
    leadActivitySelect(leadId, organizationId).limit(limit).offset(offset),
    leadActivityCount(leadId, organizationId),
  ]);

  const total = count?.value ?? 0;

  return {
    data: rows.map(toActivityEntry),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};
