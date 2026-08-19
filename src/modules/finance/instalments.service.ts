import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  invoiceInstalments,
  type NewInvoiceInstalment,
} from "../../db/schema/invoice-instalments";
import { invoices } from "../../db/schema/invoices";
import { withTransaction } from "../../db/transaction-context";
import { createModuleLogger } from "../../lib/logging/log";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { sendScheduleUpdate } from "./deliveries.service";
import { logFinanceEvent } from "./finance-events.service";
import type { ScheduleRow } from "./instalments";
import { money, num } from "./money";
import { recalculateInvoiceTotals } from "./totals";
import type { AccountAccess } from "./types";

const log = createModuleLogger("instalments.service");

/**
 * Reading and writing payment schedules.
 *
 * The arithmetic — generating a schedule, and allocating a payment down one —
 * lives in the pure `instalments.ts` beside this, so `totals.ts` can import it
 * without a cycle back through this module's database calls.
 */

// ── Reads ────────────────────────────────────────────────────────────────────

export const listInstalments = async (
  organizationId: string,
  invoiceId: string,
) =>
  db
    .select({
      id: invoiceInstalments.id,
      sequence: invoiceInstalments.sequence,
      dueDate: invoiceInstalments.dueDate,
      amount: invoiceInstalments.amount,
    })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceInstalments.sequence));

/**
 * A schedule that does not sum to the invoice total is a receivable that partly
 * does not exist: `duesFrom` emits instalment rows for any invoice that HAS a
 * schedule, so a short one silently deletes the difference from the aging
 * report — no error, just less money than the firm is owed.
 *
 * 0.005 is the tolerance `recordPayment` already uses on the operating/trust
 * split. Amounts are written through `money()` at 2dp, so anything beyond a
 * half-cent is a real mismatch.
 */
export const assertScheduleBalances = async (
  organizationId: string,
  invoiceId: string,
  totalAmount: number,
): Promise<void> => {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      sum: sql<string>`coalesce(sum(${invoiceInstalments.amount}), 0)`,
    })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, invoiceId),
      ),
    );

  if ((row?.n ?? 0) === 0) return; // No schedule — nothing to balance.

  const scheduled = num(row?.sum);
  if (Math.abs(scheduled - totalAmount) >= 0.005) {
    log.warn("instalment.created", { reason: "schedule balance mismatch", scheduled, totalAmount });
    throw new BadRequestError(
      `The payment schedule totals ${scheduled.toFixed(2)} but the invoice ` +
        `totals ${totalAmount.toFixed(2)}. Send the revised schedule with this change.`,
    );
  }
};

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Replace an invoice's schedule.
 *
 * Deletes the whole set and re-inserts rather than diffing. The unique index on
 * (invoice_id, sequence) cannot be DEFERRABLE — drizzle has no option for it —
 * so renumbering in place fails on any overlap, which is exactly what inserting
 * a row in the middle does. `replaceInvoiceLines` deletes first for the same
 * reason.
 *
 * Must be called inside a transaction. Does NOT recalculate totals or assert the
 * balance: the callers already sit inside one, and `update()` needs the lines
 * written before the total it is asserting against is meaningful.
 */
export const writeSchedule = async (
  organizationId: string,
  invoiceId: string,
  rows: ScheduleRow[],
): Promise<void> => {
  await db
    .delete(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, invoiceId),
      ),
    );

  if (rows.length === 0) return;

  // Sorted then renumbered, so `sequence` and due-date order are always the
  // same ordering. dues.ts relies on that for a deterministic window tiebreak.
  const ordered = [...rows].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const values: NewInvoiceInstalment[] = ordered.map((row, index) => ({
    organizationId,
    invoiceId,
    sequence: index + 1,
    dueDate: row.dueDate,
    amount: money(row.amount),
  }));

  await db.insert(invoiceInstalments).values(values);

  // The header due date is what the PDF prints and the delivery email bolds.
  // Pin it to the last instalment so an invoice can never read "Due: 15 Jan"
  // while its schedule runs to March.
  await db
    .update(invoices)
    .set({ dueDate: ordered[ordered.length - 1]!.dueDate, updatedAt: new Date() })
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    );
};

/**
 * Set or revise a schedule from its own endpoint.
 *
 * Line items are draft-only, but a schedule may be revised after sending: plans
 * get renegotiated, and that is the point of offering one. The revision is
 * recorded so the trail shows the plan changed and who changed it.
 */
export const setSchedule = async (
  organizationId: string,
  invoiceId: string,
  rows: ScheduleRow[],
  actorStaffId: string | null,
  access: AccountAccess,
) => {
  const [existing] = await db
    .select({
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) { log.warn("instalment.created", { reason: "not found" }); throw new NotFoundError("Invoice not found"); }
  if (existing.status === "void") {
    log.warn("instalment.created", { reason: "voided invoice", invoiceId });
    throw new BadRequestError("A voided invoice cannot be scheduled");
  }
  if (existing.status === "paid") {
    log.warn("instalment.created", { reason: "paid invoice", invoiceId });
    throw new BadRequestError(
      "This invoice is already paid, so there is nothing left to schedule",
    );
  }
  if (rows.length === 0) {
    log.warn("instalment.created", { reason: "empty schedule", invoiceId });
    throw new BadRequestError("A schedule needs at least one instalment");
  }

  const hadSchedule = (await listInstalments(organizationId, invoiceId)).length > 0;

  const totals = await withTransaction(db, async () => {
    await writeSchedule(organizationId, invoiceId, rows);
    const result = await recalculateInvoiceTotals(organizationId, invoiceId);
    await assertScheduleBalances(organizationId, invoiceId, result.totalAmount);

    await logFinanceEvent({
      organizationId,
      action: hadSchedule ? "finance.invoice_schedule_revised" : "finance.invoice_schedule_set",
      title: `${existing.invoiceNumber} — payment schedule ${
        hadSchedule ? "revised" : "set"
      }`,
      description: `${rows.length} instalment${rows.length === 1 ? "" : "s"}, ${
        rows[0]!.dueDate
      } to ${rows[rows.length - 1]!.dueDate}`,
      amount: result.totalAmount,
      invoiceId,
      actorId: actorStaffId,
    });

    log.action("instalment.created", { invoiceId, count: rows.length });

    return result;
  });

  // AFTER the commit, deliberately. An email cannot be rolled back, so sending
  // inside the transaction would mean a later failure retracts the schedule the
  // client has already been told about. Same ordering doctrine as `deliver`.
  //
  // A failed notification does not undo the schedule either — the plan is
  // agreed, the telling is what went wrong — so the outcome is returned rather
  // than thrown, and the caller reports it.
  const notification = await sendScheduleUpdate(
    organizationId,
    invoiceId,
    actorStaffId,
    access,
    { revised: hadSchedule },
  );

  return { totals, notification };
};

/** Drop the schedule; the invoice reverts to a single header due date. */
export const removeSchedule = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
) => {
  const [existing] = await db
    .select({
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) { log.warn("instalment.created", { reason: "not found" }); throw new NotFoundError("Invoice not found"); }
  if (existing.status === "void") {
    log.warn("instalment.created", { reason: "voided invoice", invoiceId });
    throw new BadRequestError("A voided invoice cannot be edited");
  }

  return withTransaction(db, async () => {
    const rows = await listInstalments(organizationId, invoiceId);
    if (rows.length === 0) {
      log.warn("instalment.created", { reason: "no schedule to remove", invoiceId });
      throw new BadRequestError("This invoice has no payment schedule");
    }

    await db
      .delete(invoiceInstalments)
      .where(
        and(
          eq(invoiceInstalments.organizationId, organizationId),
          eq(invoiceInstalments.invoiceId, invoiceId),
        ),
      );

    // The header due date keeps whatever the final instalment left it at —
    // moving it would silently change what the client owes and when.
    const totals = await recalculateInvoiceTotals(organizationId, invoiceId);

    await logFinanceEvent({
      organizationId,
      action: "finance.invoice_schedule_removed",
      title: `${existing.invoiceNumber} — payment schedule removed`,
      description: `Now due in full on ${existing.dueDate}`,
      amount: totals.totalAmount,
      invoiceId,
      actorId: actorStaffId,
    });

    log.action("instalment.created", { invoiceId, action: "schedule_removed" });

    return totals;
  });
};

/** Release every schedule row for a set of invoices (used by the void path). */
export const clearSchedules = async (
  organizationId: string,
  invoiceIds: string[],
): Promise<void> => {
  if (invoiceIds.length === 0) return;
  await db
    .delete(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        inArray(invoiceInstalments.invoiceId, invoiceIds),
      ),
    );
};
