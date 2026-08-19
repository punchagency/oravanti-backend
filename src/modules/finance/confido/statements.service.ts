import { desc, eq } from "drizzle-orm";
import { systemDb } from "../../../db/client";
import {
  confidoStatementDebits,
  confidoStatements,
} from "../../../db/schema/confido-statements";
import { money } from "../money";
import { confidoCredentialFor } from "../../settings/payments/payment-settings.service";
import { getConfidoClient } from "./confido.client";
import type { ConfidoStatementRecord } from "./confido.types";

/**
 * Confido's monthly statements, stored so the operating account reconciles.
 *
 * Processing fees never reach `invoice_payments` — they are a firm expense, not
 * a client payment — so without this there is a monthly debit sitting between
 * what our ledger says was collected and what the bank shows. The statement is
 * the entry that explains it.
 */

/** Every amount Confido reports on a statement is in cents. */
const fromCents = (cents: number): number => cents / 100;

/**
 * Fold the per-account rows into the figures the firm recognises.
 *
 * `Statement` has no summary fields — payment volume, total fees and net fees
 * are Confido's own statement-UI figures, derived rather than returned. The
 * definitions are theirs: total fees INCLUDES anything clients paid through
 * surcharging, and net fees is what the firm actually bore.
 */
const summarise = (record: ConfidoStatementRecord) => {
  const sum = (pick: (a: ConfidoStatementRecord["bankAccounts"][number]) => number) =>
    record.bankAccounts.reduce((total, a) => total + pick(a), 0);

  const totalFees = sum((a) => a.totalFees);
  const feesPaidByClients = sum((a) => a.surchargeFeesCollected);

  return {
    paymentVolume: fromCents(sum((a) => a.totalPaymentVolume)),
    totalFees: fromCents(totalFees),
    feesPaidByClients: fromCents(feesPaidByClients),
    netFees: fromCents(totalFees - feesPaidByClients),
  };
};

/**
 * Store one statement, replacing any earlier version of it.
 *
 * `statement.updated` is rare — the docs say statements should be final when
 * created — but it exists, so an upsert keyed on Confido's id is what stops a
 * revision becoming a duplicate. Debits are replaced wholesale rather than
 * diffed: they are Confido's line items, not ours to merge.
 */
const persist = async (
  organizationId: string,
  record: ConfidoStatementRecord,
): Promise<void> => {
  const totals = summarise(record);

  const [stored] = await systemDb
    .insert(confidoStatements)
    .values({
      organizationId,
      confidoStatementId: record.id,
      month: record.month,
      paymentVolume: money(totals.paymentVolume),
      totalFees: money(totals.totalFees),
      feesPaidByClients: money(totals.feesPaidByClients),
      netFees: money(totals.netFees),
      bankAccounts: record.bankAccounts,
    })
    .onConflictDoUpdate({
      target: confidoStatements.confidoStatementId,
      set: {
        month: record.month,
        paymentVolume: money(totals.paymentVolume),
        totalFees: money(totals.totalFees),
        feesPaidByClients: money(totals.feesPaidByClients),
        netFees: money(totals.netFees),
        bankAccounts: record.bankAccounts,
        updatedAt: new Date(),
      },
    })
    .returning({ id: confidoStatements.id });

  if (!stored) return;

  await systemDb
    .delete(confidoStatementDebits)
    .where(eq(confidoStatementDebits.statementId, stored.id));

  if (record.debits.length) {
    await systemDb.insert(confidoStatementDebits).values(
      record.debits.map((d) => ({
        organizationId,
        statementId: stored.id,
        amount: money(fromCents(d.amount)),
        fromBankAccountCategory: d.fromBankAccountCategory,
        fromBankAccountMask: d.fromBankAccountMask,
        statementDescriptor: d.statementDescriptor,
      })),
    );
  }
};

/**
 * Pull the firm's recent statements and store them.
 *
 * Driven by `statement.created` / `statement.updated`, but deliberately not
 * keyed on the event's id: there is no `statement(id:)` query, so the only read
 * path is a window of recent statements. Syncing the whole window rather than
 * hunting for one id means a missed webhook is repaired by the next one, which
 * matters because a statement outside the window is otherwise unreachable.
 *
 * Runs in the webhook worker, outside RLS, so every write names the
 * organization explicitly.
 */
export const syncStatements = async (
  organizationId: string,
): Promise<number> => {
  const { credential } = await confidoCredentialFor(organizationId);
  const records = await getConfidoClient().listStatements(credential);

  for (const record of records) {
    await persist(organizationId, record);
  }
  return records.length;
};

/** Statements for the Reports tab, newest first, with their debit lines. */
export const listStatementsForOrg = async (organizationId: string) => {
  const rows = await systemDb
    .select()
    .from(confidoStatements)
    .where(eq(confidoStatements.organizationId, organizationId))
    .orderBy(desc(confidoStatements.month));

  if (!rows.length) return [];

  const debits = await systemDb
    .select()
    .from(confidoStatementDebits)
    .where(eq(confidoStatementDebits.organizationId, organizationId));

  return rows.map((row) => ({
    id: row.id,
    month: row.month,
    paymentVolume: Number(row.paymentVolume),
    totalFees: Number(row.totalFees),
    feesPaidByClients: Number(row.feesPaidByClients),
    netFees: Number(row.netFees),
    /**
     * Net fees over volume — what processing actually costs the firm. Derived
     * rather than stored, being a ratio of two columns already here.
     */
    effectiveRate:
      Number(row.paymentVolume) > 0
        ? Number(row.netFees) / Number(row.paymentVolume)
        : null,
    bankAccounts: row.bankAccounts,
    debits: debits
      .filter((d) => d.statementId === row.id)
      .map((d) => ({
        amount: Number(d.amount),
        fromBankAccountCategory: d.fromBankAccountCategory,
        fromBankAccountMask: d.fromBankAccountMask,
        statementDescriptor: d.statementDescriptor,
      })),
  }));
};
