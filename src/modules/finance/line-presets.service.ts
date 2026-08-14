import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  invoiceLinePresets,
  type InvoiceLinePreset,
} from "../../db/schema/invoice-line-presets";
import { canWriteTrust, requireTrustWrite } from "./account-access";
import { num } from "./money";
import type { AccountAccess } from "./types";

/**
 * The catalog manual invoice lines are composed from.
 *
 * Two tiers live in one table, separated by `organization_id` — see the note on
 * the table itself. This module is the only place that reads them, and it is
 * responsible for three things the raw rows do not express:
 *
 *   1. **Widening.** A matter's presets are its case type's, plus its practice
 *      area's, plus the unscoped ones. Ranked most-specific first so the picker
 *      can group them under headings without recomputing the rule.
 *   2. **Shadowing.** A firm row carrying `shadows_preset_id` replaces the
 *      shipped row it names, which then has to disappear from the list.
 *   3. **Trust visibility.** A caller who cannot write trust lines is not shown
 *      trust presets. That is a UX filter, not the security boundary — the
 *      boundary is `requireTrustWrite` inside `invoices.service.create`.
 */

export type LinePresetRank = "case_type" | "practice_area" | "general";

export type LinePresetRow = {
  id: string;
  name: string;
  note: string | null;
  account: "operating" | "trust_iolta";
  defaultRate: number;
  /** How this preset was matched — drives the picker's group headings. */
  rank: LinePresetRank;
  /** `firm` rows are the firm's own; `shipped` rows came with the product. */
  origin: "firm" | "shipped";
};

export type ListLinePresetsInput = {
  practiceAreaId?: string;
  caseTypeId?: string;
  account?: "operating" | "trust_iolta";
};

const toRow = (
  preset: Pick<
    InvoiceLinePreset,
    "id" | "name" | "note" | "account" | "defaultRate" | "organizationId"
  >,
  rank: LinePresetRank,
): LinePresetRow => ({
  id: preset.id,
  name: preset.name,
  note: preset.note,
  account: preset.account,
  defaultRate: num(preset.defaultRate),
  rank,
  origin: preset.organizationId ? "firm" : "shipped",
});

export const listPresets = async (
  organizationId: string,
  access: AccountAccess,
  input: ListLinePresetsInput,
): Promise<LinePresetRow[]> => {
  // An account filter the caller may not write is answered with nothing rather
  // than an error: the picker hides the Trust step for these callers, so a
  // request for it can only come from a stale client.
  if (input.account === "trust_iolta" && !canWriteTrust(access)) return [];

  const scopeMatches = and(
    // A preset scoped to a case type shows only for that case type; one scoped
    // to a practice area shows for every case type within it; one scoped to
    // neither shows always. Written as "null OR equal" rather than as three
    // separate queries so the widening is a single scan.
    input.caseTypeId
      ? or(
          isNull(invoiceLinePresets.caseTypeId),
          eq(invoiceLinePresets.caseTypeId, input.caseTypeId),
        )
      : isNull(invoiceLinePresets.caseTypeId),
    input.practiceAreaId
      ? or(
          isNull(invoiceLinePresets.practiceAreaId),
          eq(invoiceLinePresets.practiceAreaId, input.practiceAreaId),
        )
      : isNull(invoiceLinePresets.practiceAreaId),
  );

  const rows = await db
    .select({
      id: invoiceLinePresets.id,
      name: invoiceLinePresets.name,
      note: invoiceLinePresets.note,
      account: invoiceLinePresets.account,
      defaultRate: invoiceLinePresets.defaultRate,
      organizationId: invoiceLinePresets.organizationId,
      practiceAreaId: invoiceLinePresets.practiceAreaId,
      caseTypeId: invoiceLinePresets.caseTypeId,
    })
    .from(invoiceLinePresets)
    .where(
      and(
        eq(invoiceLinePresets.active, true),
        // RLS already restricts this to NULL-org rows plus this firm's, but the
        // predicate is repeated because the checks and the CLI run outside
        // request context where no policy applies.
        or(
          isNull(invoiceLinePresets.organizationId),
          eq(invoiceLinePresets.organizationId, organizationId),
        ),
        input.account ? eq(invoiceLinePresets.account, input.account) : undefined,
        scopeMatches,
        // Drop any shipped preset this firm has replaced with its own.
        sql`${invoiceLinePresets.id} NOT IN (
              SELECT shadows_preset_id FROM invoice_line_presets
              WHERE organization_id = ${organizationId}
                AND shadows_preset_id IS NOT NULL
            )`,
      ),
    );

  const ranked = rows
    .filter((row) => canWriteTrust(access) || row.account !== "trust_iolta")
    .map((row) =>
      toRow(
        row,
        row.caseTypeId
          ? "case_type"
          : row.practiceAreaId
            ? "practice_area"
            : "general",
      ),
    );

  // Sorted here rather than in SQL: the rank is derived, and expressing it as a
  // CASE in ORDER BY would put the rule in two places.
  const rankOrder: Record<LinePresetRank, number> = {
    case_type: 0,
    practice_area: 1,
    general: 2,
  };

  return ranked.sort(
    (a, b) =>
      rankOrder[a.rank] - rankOrder[b.rank] ||
      // A firm's own entry outranks the shipped one it sits beside.
      (a.origin === b.origin ? 0 : a.origin === "firm" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
};

export type SaveLinePresetInput = {
  name: string;
  note?: string;
  account: "operating" | "trust_iolta";
  defaultRate: number;
  practiceAreaId?: string;
  caseTypeId?: string;
};

/**
 * Save a custom line to the firm's own list.
 *
 * Re-saving the same name at a new amount UPDATES it. That is deliberate: it
 * is the closest thing to editing a preset until the edit screen exists, and
 * it means the second save is never an error the user has to interpret.
 *
 * Read-then-write rather than `onConflictDoUpdate`, for the same reason the CLI
 * seeder is — the unique index is an expression index and Drizzle's conflict
 * target takes plain columns. The index remains the backstop: a lost race
 * raises 23505 rather than writing a duplicate, and the caller sees a failed
 * save instead of a list with the same entry twice.
 */
export const saveFirmPreset = async (
  organizationId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  input: SaveLinePresetInput,
): Promise<LinePresetRow> => {
  if (input.account === "trust_iolta") requireTrustWrite(access);

  const [existing] = await db
    .select({ id: invoiceLinePresets.id })
    .from(invoiceLinePresets)
    .where(
      and(
        eq(invoiceLinePresets.organizationId, organizationId),
        eq(invoiceLinePresets.account, input.account),
        sql`lower(${invoiceLinePresets.name}) = lower(${input.name})`,
        input.practiceAreaId
          ? eq(invoiceLinePresets.practiceAreaId, input.practiceAreaId)
          : isNull(invoiceLinePresets.practiceAreaId),
        input.caseTypeId
          ? eq(invoiceLinePresets.caseTypeId, input.caseTypeId)
          : isNull(invoiceLinePresets.caseTypeId),
      ),
    )
    .limit(1);

  const values = {
    name: input.name,
    note: input.note ?? null,
    defaultRate: input.defaultRate.toFixed(4),
    active: true,
    updatedAt: new Date(),
  };

  const [saved] = existing
    ? await db
        .update(invoiceLinePresets)
        .set(values)
        .where(eq(invoiceLinePresets.id, existing.id))
        .returning()
    : await db
        .insert(invoiceLinePresets)
        .values({
          ...values,
          organizationId,
          account: input.account,
          practiceAreaId: input.practiceAreaId ?? null,
          caseTypeId: input.caseTypeId ?? null,
          createdById: actorStaffId,
        })
        .returning();

  return toRow(
    saved!,
    saved!.caseTypeId
      ? "case_type"
      : saved!.practiceAreaId
        ? "practice_area"
        : "general",
  );
};
