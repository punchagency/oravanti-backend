import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { leadEvents } from "../../db/schema/leads";
import type { LeadEventType } from "../../db/schema/leads";
import { staff } from "../../db/schema/staff";

/**
 * Append-only activity trail for a lead. Mirrors the shape of
 * workflow.service.ts `logEvent()`, which does the same job for cases.
 *
 * Nothing in this module updates or deletes an event, and no route exposes a
 * path that would — the trail is the record of what happened, so a correction
 * is a new event, never an edit.
 */

type LogLeadEventInput = {
  organizationId: string;
  leadId: string;
  type: LeadEventType;
  /**
   * Null for lead-driven and system events — a lead paying through the booking
   * link, a Dropbox Sign webhook firing. Never invent a staff member for these.
   */
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  /** Pass the enclosing transaction so the event commits with the action. */
  tx?: any;
};

/**
 * Denormalised so the trail still reads correctly after a staff member is
 * removed from the firm.
 */
const actorNameFor = async (
  conn: typeof db,
  actorId: string | null | undefined,
): Promise<string | null> => {
  if (!actorId) return null;

  const [row] = await conn
    .select({ firstName: staff.firstName, lastName: staff.lastName })
    .from(staff)
    .where(eq(staff.id, actorId))
    .limit(1);

  return row ? `${row.firstName} ${row.lastName}`.trim() : null;
};

export const logLeadEvent = async (data: LogLeadEventInput) => {
  const conn = (data.tx ?? db) as typeof db;
  const actorId = data.actorId ?? null;

  await conn.insert(leadEvents).values({
    organizationId: data.organizationId,
    leadId: data.leadId,
    type: data.type,
    actorId,
    actorNameSnapshot: await actorNameFor(conn, actorId),
    metadata: (data.metadata as any) ?? null,
  });
};

export type LeadActivityEntry = {
  id: string;
  type: LeadEventType;
  actorId: string | null;
  /**
   * Null where the actor is genuinely unknown — a system/lead-driven event, or
   * a backfilled event predating the trail. Callers must render the absence,
   * not guess a name.
   */
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export const getLeadActivity = async (
  leadId: string,
  organizationId: string,
): Promise<LeadActivityEntry[]> => {
  const rows = await db
    .select({
      id: leadEvents.id,
      type: leadEvents.type,
      actorId: leadEvents.actorId,
      actorNameSnapshot: leadEvents.actorNameSnapshot,
      // Prefer the live staff name so a rename is reflected, and fall back to
      // the snapshot when the staff row is gone.
      firstName: staff.firstName,
      lastName: staff.lastName,
      metadata: leadEvents.metadata,
      createdAt: leadEvents.createdAt,
    })
    .from(leadEvents)
    .leftJoin(staff, eq(leadEvents.actorId, staff.id))
    .where(
      and(
        eq(leadEvents.leadId, leadId),
        eq(leadEvents.organizationId, organizationId),
      ),
    )
    .orderBy(desc(leadEvents.createdAt));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actorId: r.actorId,
    actorName: r.firstName
      ? `${r.firstName} ${r.lastName}`.trim()
      : r.actorNameSnapshot,
    metadata: r.metadata as Record<string, unknown> | null,
    createdAt: r.createdAt,
  }));
};
