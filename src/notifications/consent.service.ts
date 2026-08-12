import { and, eq, isNull, sql } from "drizzle-orm";
import { systemDb } from "../db/client";
import { clients } from "../db/schema/clients";
import { emailSuppressions } from "../db/schema/email-suppressions";
import { leads } from "../db/schema/leads";
import { toE164 } from "../utils/phone";
import type { ResolvedRecipient } from "./types";

/**
 * SMS consent and email suppression.
 *
 * THIS FILE CONTAINS THE SYSTEM'S ONLY DELIBERATE CROSS-TENANT WRITES, and they
 * are correct.
 *
 * The platform sends every firm's SMS from one shared number and every firm's
 * email from one shared domain. When someone texts STOP, they are telling that
 * NUMBER to stop texting them — not one law firm out of the several that might
 * hold their details. Applying the opt-out to a single organization would leave
 * the other firms happily texting a person who has already refused, from the
 * same number they refused. Email suppression follows identically: a hard
 * bounce is a fact about a mailbox, and continuing to send to it damages a
 * sending reputation every firm on the platform shares.
 *
 * So both write across organizations, through `systemDb`, with an explicit
 * predicate on the normalised phone or lowercased email. Neither table carries
 * an RLS policy, because a row scoped to no organization cannot be filtered by
 * one — documented alongside the policies in src/db/schema/rls.ts.
 */

// ─── SMS ──────────────────────────────────────────────────────────────────────

/**
 * The invariant, in one place: consent granted AND never withdrawn.
 *
 * Both halves are load-bearing. `smsConsent` alone would let a stale true
 * survive an opt-out; `smsOptOutAt` alone could not distinguish "never asked"
 * from "asked and agreed".
 */
export const hasSmsConsent = (recipient: ResolvedRecipient): boolean =>
  recipient.smsConsent && recipient.smsOptOutAt === null;

export type ConsentSource = "intake_form" | "staff_manual" | "sms_start";

export type OptOutResult = { leads: number; clients: number };

/**
 * Apply an inbound STOP across every organization.
 *
 * Matching is on the E.164 form. Stored phones are free text in whatever shape
 * someone typed, so a direct comparison would miss "(415) 555-2671" while the
 * inbound arrives as "+14155552671" — and a missed opt-out means we keep
 * texting someone who told us to stop. Normalising in SQL is not available
 * (libphonenumber is a JS library), so this reads the candidate rows and
 * filters in memory. The volume is small: this runs once per inbound keyword,
 * not per send.
 */
export const applyGlobalOptOut = async (
  phone: string,
  source: string,
): Promise<OptOutResult> => {
  const e164 = toE164(phone);
  if (!e164) return { leads: 0, clients: 0 };

  const now = new Date();

  const leadIds = await matchingPhoneIds("leads", e164);
  const clientIds = await matchingPhoneIds("clients", e164);

  if (leadIds.length) {
    await systemDb
      .update(leads)
      // Both columns: smsOptOutAt is the audit fact, smsConsent is the decision
      // the send path reads. Setting only one would leave them disagreeing.
      .set({ smsConsent: false, smsOptOutAt: now, updatedAt: now })
      .where(inIds(leads.id, leadIds));
  }

  if (clientIds.length) {
    await systemDb
      .update(clients)
      .set({ smsConsent: false, smsOptOutAt: now, updatedAt: now })
      .where(inIds(clients.id, clientIds));
  }

  console.log(
    `[sms] opt-out applied (${source}): ${leadIds.length} leads, ${clientIds.length} clients`,
  );

  return { leads: leadIds.length, clients: clientIds.length };
};

/**
 * Apply an inbound START across every organization.
 *
 * Deliberately symmetric with the opt-out, and deliberately the ONLY way an
 * opt-out is reversed. Staff cannot clear `smsOptOutAt` from the admin UI —
 * `updateLead` refuses — because the person who said stop is the only one who
 * can say start.
 */
export const applyGlobalOptIn = async (
  phone: string,
  source: string,
): Promise<OptOutResult> => {
  const e164 = toE164(phone);
  if (!e164) return { leads: 0, clients: 0 };

  const now = new Date();

  const leadIds = await matchingPhoneIds("leads", e164);
  const clientIds = await matchingPhoneIds("clients", e164);

  if (leadIds.length) {
    await systemDb
      .update(leads)
      .set({
        smsConsent: true,
        smsConsentAt: now,
        smsConsentSource: source,
        smsOptOutAt: null,
        updatedAt: now,
      })
      .where(inIds(leads.id, leadIds));
  }

  if (clientIds.length) {
    await systemDb
      .update(clients)
      .set({
        smsConsent: true,
        smsConsentAt: now,
        smsConsentSource: source,
        smsOptOutAt: null,
        updatedAt: now,
      })
      .where(inIds(clients.id, clientIds));
  }

  console.log(
    `[sms] opt-in applied (${source}): ${leadIds.length} leads, ${clientIds.length} clients`,
  );

  return { leads: leadIds.length, clients: clientIds.length };
};

/**
 * Candidate ids whose stored phone normalises to `e164`.
 *
 * A cheap SQL pre-filter on the last seven digits keeps this from reading every
 * row in the table: any formatting of the same number preserves its trailing
 * digits, so the digits-only suffix is a safe superset. The exact match is then
 * confirmed in JS via toE164.
 */
const matchingPhoneIds = async (
  table: "leads" | "clients",
  e164: string,
): Promise<string[]> => {
  const suffix = e164.replace(/\D/g, "").slice(-7);

  const rows =
    table === "leads"
      ? await systemDb
          .select({ id: leads.id, phone: leads.phone })
          .from(leads)
          .where(sql`regexp_replace(${leads.phone}, '[^0-9]', '', 'g') LIKE ${`%${suffix}`}`)
      : await systemDb
          .select({ id: clients.id, phone: clients.phone })
          .from(clients)
          .where(sql`regexp_replace(${clients.phone}, '[^0-9]', '', 'g') LIKE ${`%${suffix}`}`);

  return rows.filter((row) => toE164(row.phone) === e164).map((row) => row.id);
};

const inIds = (column: any, ids: string[]) =>
  sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;

/**
 * Staff-initiated consent change on one record.
 *
 * Refuses to reverse an opt-out — see applyGlobalOptIn. The lead update path
 * enforces the same rule; this exists for the client side and for any future
 * caller, so the rule is not one endpoint's private knowledge.
 */
export const setSmsConsent = async (
  organizationId: string,
  subject: { type: "lead" | "client"; id: string },
  consent: boolean,
  source: ConsentSource = "staff_manual",
): Promise<void> => {
  const now = new Date();
  const table = subject.type === "lead" ? leads : clients;

  const [existing] = await systemDb
    .select({ smsOptOutAt: table.smsOptOutAt })
    .from(table)
    .where(
      and(eq(table.id, subject.id), eq(table.organizationId, organizationId)),
    )
    .limit(1);

  if (!existing) return;
  if (existing.smsOptOutAt && consent) {
    throw new Error(
      "This contact opted out of SMS. They must text START to opt back in.",
    );
  }

  await systemDb
    .update(table)
    .set({
      smsConsent: consent,
      smsConsentAt: consent ? now : null,
      smsConsentSource: consent ? source : null,
      updatedAt: now,
    })
    .where(
      and(eq(table.id, subject.id), eq(table.organizationId, organizationId)),
    );
};

// ─── Email ────────────────────────────────────────────────────────────────────

export type SuppressionReason =
  | "bounced"
  | "complained"
  | "provider_suppressed"
  | "manual";

/**
 * The suppression reason for an address, or null when it is sendable.
 *
 * Returns the reason rather than a boolean so the notification row can record
 * WHY, and the UI can distinguish "bounced" (probably a typo — fix the address)
 * from "complained" (they reported you as spam — do not try again).
 */
export const getEmailSuppression = async (
  email: string,
): Promise<SuppressionReason | null> => {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;

  const [row] = await systemDb
    .select({ reason: emailSuppressions.reason })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.email, normalised),
        isNull(emailSuppressions.removedAt),
      ),
    )
    .limit(1);

  return row?.reason ?? null;
};

/**
 * Record a suppression. Idempotent: a redelivered webhook must not throw.
 *
 * An address already suppressed for one reason and re-reported for another is
 * updated to the newer reason — a complaint after a bounce is the more serious
 * of the two, and either way the newest signal is the accurate one.
 */
export const suppressEmail = async (
  email: string,
  reason: SuppressionReason,
  providerEventId?: string,
  organizationId?: string | null,
): Promise<void> => {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return;

  await systemDb
    .insert(emailSuppressions)
    .values({
      email: normalised,
      reason,
      providerEventId: providerEventId ?? null,
      organizationId: organizationId ?? null,
    })
    .onConflictDoUpdate({
      target: emailSuppressions.email,
      set: {
        reason,
        providerEventId: providerEventId ?? null,
        suppressedAt: new Date(),
        // Re-suppressing an address that had been reinstated must clear the
        // reinstatement, or the row would claim to be both.
        removedAt: null,
      },
    });

  console.log(`[email] suppressed ${normalised} (${reason})`);
};

/** Lift a suppression, in response to the provider reporting the address reinstated. */
export const unsuppressEmail = async (email: string): Promise<void> => {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return;

  await systemDb
    .update(emailSuppressions)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(emailSuppressions.email, normalised),
        isNull(emailSuppressions.removedAt),
      ),
    );

  console.log(`[email] suppression lifted for ${normalised}`);
};
