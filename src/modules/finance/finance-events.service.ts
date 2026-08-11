import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { clients } from "../../db/schema/clients";
import {
  financeEvents,
  type FinanceEventType,
} from "../../db/schema/finance-events";
import { invoices } from "../../db/schema/invoices";
import type { PaymentMethod } from "../../db/schema/invoices";
import { staff } from "../../db/schema/staff";
import { getRequestContext } from "../../middleware/request-context";
import { money, numOrNull } from "./money";
import type { FinanceActivityEntry } from "./types";

/**
 * Append-only activity trail for the finance module, mirroring the proven
 * `case-events.service.ts` pattern.
 *
 * Nothing here updates or deletes an event and no route exposes a path that
 * would — the trail is the record of what happened, so a correction is a new
 * event, never an edit.
 */

/** Well-known sentinel for system-initiated events (no human actor). */
const SYSTEM_ACTOR_NAME = "System";

type LogFinanceEventInput = {
  organizationId: string;
  eventType: FinanceEventType;
  title: string;
  description?: string | null;
  amount?: number | null;
  paymentMethod?: PaymentMethod | null;
  invoiceId?: string | null;
  timeEntryId?: string | null;
  caseId?: string | null;
  clientId?: string | null;
  metadata?: Record<string, unknown> | null;
  actorId?: string | null;
  /** Override the auto-resolved actor name (e.g. "System"). */
  actorNameSnapshot?: string | null;
};

/**
 * Denormalised so the trail still reads correctly after a staff member is
 * removed from the firm.
 */
const actorNameFor = async (
  actorId: string,
  organizationId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ firstName: staff.firstName, lastName: staff.lastName })
    .from(staff)
    .where(and(eq(staff.id, actorId), eq(staff.organizationId, organizationId)))
    .limit(1);

  return row ? `${row.firstName} ${row.lastName}`.trim() : null;
};

export const logFinanceEvent = async (
  data: LogFinanceEventInput,
): Promise<void> => {
  const ctx = getRequestContext();
  const hasActor = data.actorId != null && data.actorId !== "";

  let actorNameSnapshot = data.actorNameSnapshot ?? null;
  if (!actorNameSnapshot) {
    actorNameSnapshot = hasActor
      ? await actorNameFor(data.actorId!, data.organizationId)
      : SYSTEM_ACTOR_NAME;
  }

  await db.insert(financeEvents).values({
    organizationId: data.organizationId,
    eventType: data.eventType,
    title: data.title,
    description: data.description ?? null,
    amount: data.amount == null ? null : money(data.amount),
    paymentMethod: data.paymentMethod ?? null,
    invoiceId: data.invoiceId ?? null,
    timeEntryId: data.timeEntryId ?? null,
    caseId: data.caseId ?? null,
    clientId: data.clientId ?? null,
    metadata: data.metadata ?? null,
    actorId: hasActor ? data.actorId! : null,
    actorNameSnapshot,
    ipAddress: ctx.ipAddress,
  });
};

/**
 * The Invoicing tab's "Recent activity" feed.
 *
 * Reads one table on one index (finance_events_org_created_at_idx). The
 * alternative — a three-way UNION ALL over payments, follow-ups and
 * invoices.sent_at — reads three tables and cannot be indexed for the combined
 * ordering. That is the strongest argument for this table existing at all.
 */
export const getRecentActivity = async (
  organizationId: string,
  limit = 8,
): Promise<FinanceActivityEntry[]> => {
  const rows = await db
    .select({
      id: financeEvents.id,
      eventType: financeEvents.eventType,
      title: financeEvents.title,
      description: financeEvents.description,
      amount: financeEvents.amount,
      paymentMethod: financeEvents.paymentMethod,
      invoiceId: financeEvents.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      clientName: clients.displayName,
      createdAt: financeEvents.createdAt,
    })
    .from(financeEvents)
    .leftJoin(invoices, eq(invoices.id, financeEvents.invoiceId))
    .leftJoin(clients, eq(clients.id, financeEvents.clientId))
    .where(eq(financeEvents.organizationId, organizationId))
    .orderBy(desc(financeEvents.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    title: r.title,
    description: r.description,
    amount: numOrNull(r.amount),
    paymentMethod: r.paymentMethod,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    clientName: r.clientName,
    createdAt: r.createdAt,
  }));
};
