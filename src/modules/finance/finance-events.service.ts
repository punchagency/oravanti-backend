import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { clients } from "../../db/schema/clients";
import { auditEvents } from "../../db/schema/audit-events";
import { invoices, type PaymentMethod } from "../../db/schema/invoices";
import { createModuleLogger } from "../../lib/logging/log";
import { recordAuditEvent } from "../shared/audit.service";
import type { AuditActionName } from "../../lib/audit/actions";
import { money, numOrNull } from "./money";
import type { FinanceActivityEntry } from "./types";

const log = createModuleLogger("finance-events.service");

/**
 * Append-only activity trail for the finance module, mirroring the proven
 * `case-events.service.ts` pattern.
 *
 * Nothing here updates or deletes an event and no route exposes a path that
 * would — the trail is the record of what happened, so a correction is a new
 * event, never an edit.
 */

type LogFinanceEventInput = {
  organizationId: string;
  action: AuditActionName;
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

export const logFinanceEvent = async (
  data: LogFinanceEventInput,
): Promise<void> => {
  // time_entry_* events use the time entry as the primary entity;
  // everything else uses the invoice.
  const entityId = data.timeEntryId ?? data.invoiceId ?? null;

  const metadata: Record<string, unknown> = { ...(data.metadata ?? {}) };
  // The detail that says WHAT changed — the due date an invoice moved from, the
  // reason given, a payment's reference. `summary` is one rendered sentence and
  // does not carry it, so without this the trail records that something
  // happened and nothing about it. Kept structured rather than appended to the
  // sentence, because the feed has a field for it.
  if (data.description) metadata.description = data.description;
  if (data.amount != null) metadata.amount = money(data.amount);
  if (data.paymentMethod != null) metadata.paymentMethod = data.paymentMethod;
  if (data.caseId != null) metadata.caseId = data.caseId;
  if (data.clientId != null) metadata.clientId = data.clientId;

  await recordAuditEvent({
    action: data.action,
    entityId,
    organizationId: data.organizationId,
    summary: data.title,
    metadata,
    parentEntityType: data.caseId ? "case" : undefined,
    parentEntityId: data.caseId ?? undefined,
    actor: data.actorId
      ? { staffId: data.actorId, name: data.actorNameSnapshot ?? undefined }
      : undefined,
    onWriteFailure: "log",
  });

  log.action("finance.event_recorded", { action: data.action, entityId });
};

/**
 * The Invoicing tab's "Recent activity" feed.
 *
 * Reads from `audit_events` where `action` starts with `finance.`. The
 * partial index `audit_events_org_occurred_at_idx` (excluding `access`
 * category) keeps this fast.
 */
export const getRecentActivity = async (
  organizationId: string,
  limit = 8,
): Promise<FinanceActivityEntry[]> => {
  let rows;
  try {
    rows = await db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        summary: auditEvents.summary,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        description: sql<string | null>`(${auditEvents.metadata}->>'description')`,
        amount: sql<string | null>`(${auditEvents.metadata}->>'amount')`,
        paymentMethod: sql<string | null>`(${auditEvents.metadata}->>'paymentMethod')`,
        invoiceNumber: invoices.invoiceNumber,
        clientName: clients.displayName,
        occurredAt: auditEvents.occurredAt,
      })
      .from(auditEvents)
      // Both joins compare as TEXT, and neither casts the other way round.
      //
      // `audit_events.entity_id` is deliberately `text` with no foreign key —
      // it identifies rows in any table, so it cannot be a uuid column. Joining
      // it to `invoices.id` directly is `uuid = text`, which Postgres refuses
      // outright (42883): there is no implicit cast between them, so this query
      // failed every time it ran rather than only on odd data.
      //
      // Casting the other way — `entity_id::uuid` — would compile and then
      // throw on any non-uuid identifier the audit table ever holds. Widening
      // the uuid to text cannot fail, and a uuid renders identically either
      // side, so nothing stops matching.
      .leftJoin(
        invoices,
        sql`${invoices.id}::text = ${auditEvents.entityId}`,
      )
      .leftJoin(
        clients,
        sql`${clients.id}::text = (${auditEvents.metadata}->>'clientId')`,
      )
      .where(
        and(
          eq(auditEvents.organizationId, organizationId),
          like(auditEvents.action, "finance.%"),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(limit);
  } catch (err) {
    log.failure("finance.event_query_failed", err, { organizationId });
    throw err;
  }

  return rows.map((r) => ({
    id: r.id,
    eventType: r.action,
    title: r.summary,
    description: r.description,
    amount: numOrNull(r.amount),
    paymentMethod: r.paymentMethod as PaymentMethod | null,
    invoiceId:
      r.entityType === "invoice" || r.entityType === "invoice_payment"
        ? r.entityId
        : null,
    invoiceNumber: r.invoiceNumber,
    clientName: r.clientName,
    createdAt: r.occurredAt,
  }));
};
