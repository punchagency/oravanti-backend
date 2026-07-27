import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { caseEvents } from "../../db/schema/cases";
import { staff } from "../../db/schema/staff";
import { getRequestContext } from "../../middleware/request-context";

/**
 * Append-only activity trail for a case. Mirrors the proven `lead-events.service.ts`
 * pattern for consistency across the application.
 *
 * Nothing in this module updates or deletes an event, and no route exposes a
 * path that would — the trail is the record of what happened, so a correction
 * is a new event, never an edit.
 */

/** Well-known sentinel for system-initiated events (no human actor). */
const SYSTEM_ACTOR_NAME = "System";

type LogCaseEventInput = {
  organizationId: string;
  caseId: string;
  eventType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
  /** Override the auto-resolved actor name (e.g. "System"). */
  actorNameSnapshot?: string | null;
};

/**
 * Denormalised so the trail still reads correctly after a staff member is
 * removed from the firm.
 */
const actorNameFor = async (
  actorId: string | null | undefined,
  organizationId: string,
): Promise<string | null> => {
  if (!actorId) return null;

  const [row] = await db
    .select({ firstName: staff.firstName, lastName: staff.lastName })
    .from(staff)
    .where(and(eq(staff.id, actorId), eq(staff.organizationId, organizationId)))
    .limit(1);

  return row ? `${row.firstName} ${row.lastName}`.trim() : null;
};

export const logCaseEvent = async (data: LogCaseEventInput) => {
  const ctx = getRequestContext();
  const hasActor = data.actorId != null && data.actorId !== "";
  const effectiveActorId = hasActor ? data.actorId! : null;

  let actorNameSnapshot = data.actorNameSnapshot ?? null;
  if (!actorNameSnapshot) {
    if (hasActor) {
      actorNameSnapshot = await actorNameFor(
        effectiveActorId!,
        data.organizationId,
      );
    } else {
      actorNameSnapshot = SYSTEM_ACTOR_NAME;
    }
  }
  await db.insert(caseEvents).values({
    organizationId: data.organizationId,
    caseId: data.caseId,
    eventType: data.eventType as any,
    title: data.title,
    description: data.description ?? null,
    metadata: (data.metadata as any) ?? null,
    actorId: effectiveActorId,
    actorNameSnapshot,
    ipAddress: ctx.ipAddress,
  });
};

export type CaseActivityEntry = {
  id: string;
  eventType: string;
  title: string;
  description: string | null;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
};

export const getCaseActivity = async (
  caseId: string,
  organizationId: string,
): Promise<CaseActivityEntry[]> => {
  const rows = await db
    .select({
      id: caseEvents.id,
      eventType: caseEvents.eventType,
      title: caseEvents.title,
      description: caseEvents.description,
      actorId: caseEvents.actorId,
      actorNameSnapshot: caseEvents.actorNameSnapshot,
      firstName: staff.firstName,
      lastName: staff.lastName,
      metadata: caseEvents.metadata,
      ipAddress: caseEvents.ipAddress,
      createdAt: caseEvents.createdAt,
    })
    .from(caseEvents)
    .leftJoin(staff, eq(caseEvents.actorId, staff.id))
    .where(
      and(
        eq(caseEvents.caseId, caseId),
        eq(caseEvents.organizationId, organizationId),
      ),
    )
    .orderBy(desc(caseEvents.createdAt));

  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    title: r.title,
    description: r.description,
    actorId: r.actorId,
    actorName: r.firstName
      ? `${r.firstName} ${r.lastName}`.trim()
      : r.actorNameSnapshot,
    metadata: r.metadata as Record<string, unknown> | null,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt,
  }));
};

/**
 * Paginated version of getCaseActivity for the audit log endpoint.
 */
export const getCaseActivityPaginated = async (params: {
  caseId: string;
  organizationId: string;
  page?: number;
  limit?: number;
}) => {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;

  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(caseEvents)
    .where(
      and(
        eq(caseEvents.caseId, params.caseId),
        eq(caseEvents.organizationId, params.organizationId),
      ),
    );

  const rows = await db
    .select({
      id: caseEvents.id,
      eventType: caseEvents.eventType,
      title: caseEvents.title,
      description: caseEvents.description,
      actorId: caseEvents.actorId,
      actorNameSnapshot: caseEvents.actorNameSnapshot,
      firstName: staff.firstName,
      lastName: staff.lastName,
      metadata: caseEvents.metadata,
      ipAddress: caseEvents.ipAddress,
      createdAt: caseEvents.createdAt,
    })
    .from(caseEvents)
    .leftJoin(staff, eq(caseEvents.actorId, staff.id))
    .where(
      and(
        eq(caseEvents.caseId, params.caseId),
        eq(caseEvents.organizationId, params.organizationId),
      ),
    )
    .orderBy(desc(caseEvents.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    data: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      title: r.title,
      description: r.description,
      actorId: r.actorId,
      actorName: r.firstName
        ? `${r.firstName} ${r.lastName}`.trim()
        : r.actorNameSnapshot,
      metadata: r.metadata as Record<string, unknown> | null,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
    })),
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil(count / limit),
    },
  };
};

/**
 * Log a case_viewed event, but deduplicate: skip if the same staff member
 * viewed the same case within the last 5 minutes. This prevents noise from
 * tab switches, re-renders, and polling while still recording meaningful
 * access patterns.
 */
export const logCaseView = async (
  organizationId: string,
  caseId: string,
  actorId: string | null | undefined,
) => {
  if (!actorId) return;

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  try {
    const [recent] = await db
      .select({ id: caseEvents.id, createdAt: caseEvents.createdAt })
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.organizationId, organizationId),
          eq(caseEvents.caseId, caseId),
          eq(caseEvents.actorId, actorId),
          eq(caseEvents.eventType, "case_viewed"),
        ),
      )
      .orderBy(desc(caseEvents.createdAt))
      .limit(1);

    if (recent && recent.createdAt > fiveMinAgo) return;

    await logCaseEvent({
      organizationId,
      caseId,
      eventType: "case_viewed",
      title: "Case viewed",
      description: "Case viewed",
      actorId,
    });
  } catch (err) {
    console.error("[logCaseView] failed", err);
  }
};
