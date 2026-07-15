/**
 * One-time backfill of the lead activity trail.
 *
 * The trail (lead_events) only starts recording when it ships, so every lead
 * created before that would open with an empty Activity tab. This reconstructs
 * what CAN be reconstructed from rows that already carry timestamps — and, in a
 * few cases, actors.
 *
 * What it cannot reconstruct, it does not invent:
 *
 *   - Events are stamped `metadata.derived = true` so a reader can tell a
 *     reconstruction from a recorded fact.
 *   - actorId is left null wherever the actor was never stored (who archived,
 *     who scheduled a consultation, who sent an agreement). It is never guessed
 *     from a nearby column.
 *   - stage_changed is NOT emitted. Stage transitions were never timestamped,
 *     so their timing is genuinely unknowable; fabricating them would corrupt
 *     the time-in-stage metrics that read these events. Backfilled leads simply
 *     report insufficient_data there, which is the truth.
 *
 * Idempotent: skips any lead that already has events.
 *
 * Run with:  npx tsx src/scripts/backfill-lead-events.ts [--dry-run]
 */
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { cases } from "../db/schema/cases";
import { conflictChecks } from "../db/schema/conflict-checks";
import { consultations } from "../db/schema/consultations";
import { feeAgreements } from "../db/schema/fee-agreements";
import { leadEvents, leads } from "../db/schema/leads";
import type { LeadEventType, NewLeadEvent } from "../db/schema/leads";
import { questionnaireSends } from "../db/schema/questionnaires";
import { staff } from "../db/schema/staff";

const dryRun = process.argv.includes("--dry-run");

type Derived = {
  type: LeadEventType;
  actorId: string | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
};

const main = async () => {
  const allLeads = await db
    .select({
      id: leads.id,
      organizationId: leads.organizationId,
      source: leads.source,
      status: leads.status,
      respondentId: leads.respondentId,
      createdAt: leads.createdAt,
      convertedAt: leads.convertedAt,
      convertedCaseId: leads.convertedCaseId,
    })
    .from(leads);

  if (allLeads.length === 0) {
    console.log("No leads found. Nothing to backfill.");
    return;
  }

  // Idempotency: any lead that already has a trail is left alone.
  const existing = await db
    .selectDistinct({ leadId: leadEvents.leadId })
    .from(leadEvents);
  const alreadyBackfilled = new Set(existing.map((e) => e.leadId));

  const targets = allLeads.filter((l) => !alreadyBackfilled.has(l.id));
  if (targets.length === 0) {
    console.log(
      `All ${allLeads.length} leads already have activity. Nothing to do.`,
    );
    return;
  }

  const leadIds = targets.map((l) => l.id);

  const [checks, sends, consults, agreements, openedCases, staffRows] =
    await Promise.all([
      db
        .select()
        .from(conflictChecks)
        .where(inArray(conflictChecks.leadId, leadIds)),
      db
        .select()
        .from(questionnaireSends)
        .where(inArray(questionnaireSends.leadId, leadIds)),
      db
        .select()
        .from(consultations)
        .where(inArray(consultations.leadId, leadIds))
        .orderBy(asc(consultations.createdAt)),
      db
        .select()
        .from(feeAgreements)
        .where(inArray(feeAgreements.leadId, leadIds)),
      db.select().from(cases),
      db
        .select({
          id: staff.id,
          firstName: staff.firstName,
          lastName: staff.lastName,
        })
        .from(staff),
    ]);

  const staffName = new Map(
    staffRows.map((s) => [s.id, `${s.firstName} ${s.lastName}`.trim()]),
  );
  const caseById = new Map(openedCases.map((c) => [c.id, c]));

  const byLead = <T extends { leadId: string | null }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.leadId) continue;
      const list = map.get(row.leadId) ?? [];
      list.push(row);
      map.set(row.leadId, list);
    }
    return map;
  };

  const checksByLead = byLead(checks);
  const sendsByLead = byLead(sends);
  const consultsByLead = byLead(consults);
  const agreementsByLead = byLead(agreements);

  const rows: NewLeadEvent[] = [];
  let leadsWithEvents = 0;

  for (const lead of targets) {
    const derived: Derived[] = [];

    // The lead itself. respondentId is the closest thing to "who received it".
    derived.push({
      type: "lead_received",
      actorId: lead.respondentId ?? null,
      createdAt: lead.createdAt,
      metadata: { source: lead.source },
    });

    for (const check of checksByLead.get(lead.id) ?? []) {
      if (check.checkedAt) {
        derived.push({
          type: "conflict_check_run",
          actorId: check.checkedById ?? null,
          createdAt: check.checkedAt,
          metadata: {
            status: check.status,
            matchCount: Array.isArray(check.matches) ? check.matches.length : 0,
          },
        });
      }

      // Re-running a check wipes its own review columns, so only the most
      // recent resolution survives — earlier ones are unrecoverable.
      if (check.reviewedAt) {
        const overridden = lead.status === "overridden";
        const declined = lead.status === "declined";
        derived.push({
          type: declined
            ? "conflict_check_declined"
            : overridden
              ? "conflict_overridden"
              : "conflict_check_approved",
          actorId: check.reviewedById ?? null,
          createdAt: check.reviewedAt,
          metadata: { reviewNotes: check.reviewNotes ?? null },
        });
      }
    }

    for (const send of sendsByLead.get(lead.id) ?? []) {
      if (!send.sentAt) continue;
      derived.push({
        type: "questionnaire_sent",
        actorId: send.sentById ?? null,
        createdAt: send.sentAt,
        metadata: { sendId: send.id },
      });
    }

    for (const consult of consultsByLead.get(lead.id) ?? []) {
      // No scheduledById existed before this change — leave the actor unknown.
      derived.push({
        type: "consultation_scheduled",
        actorId: null,
        createdAt: consult.createdAt,
        metadata: {
          consultationId: consult.id,
          mode: consult.mode,
          scheduledAt: consult.scheduledAt?.toISOString() ?? null,
          leadAttorneyId: consult.leadAttorneyId,
        },
      });

      if (consult.status === "cancelled" && consult.cancelledAt) {
        derived.push({
          type: "consultation_cancelled",
          actorId: null,
          createdAt: consult.cancelledAt,
          metadata: {
            consultationId: consult.id,
            reason: consult.cancellationReason ?? null,
          },
        });
      } else if (consult.status === "completed") {
        // Completion was never timestamped separately; updatedAt is the best
        // available approximation and is marked as such.
        derived.push({
          type: "consultation_completed",
          actorId: null,
          createdAt: consult.updatedAt,
          metadata: {
            consultationId: consult.id,
            outcome: consult.outcome ?? null,
            timestampApproximate: true,
          },
        });
      }
    }

    for (const agreement of agreementsByLead.get(lead.id) ?? []) {
      derived.push({
        type: "fee_agreement_generated",
        actorId: null,
        createdAt: agreement.createdAt,
        metadata: {
          agreementId: agreement.id,
          feeType: agreement.details?.attorneyFee?.type ?? null,
        },
      });

      if (agreement.clientSignedAt) {
        derived.push({
          type: "fee_agreement_signed",
          actorId: null,
          createdAt: agreement.clientSignedAt,
          metadata: { agreementId: agreement.id },
        });
      }

      const paidAt = agreement.details?.paymentReceivedAt;
      if (paidAt) {
        derived.push({
          type: "payment_received",
          actorId: null,
          createdAt: new Date(paidAt),
          metadata: { kind: "fee_agreement", agreementId: agreement.id },
        });
      }
    }

    if (lead.convertedCaseId && lead.convertedAt) {
      const openedCase = caseById.get(lead.convertedCaseId);
      derived.push({
        type: "case_opened",
        actorId: openedCase?.openedById ?? null,
        createdAt: lead.convertedAt,
        metadata: {
          caseId: lead.convertedCaseId,
          caseNumber: openedCase?.caseNumber ?? null,
        },
      });
    }

    if (derived.length === 0) continue;
    leadsWithEvents += 1;

    for (const event of derived) {
      rows.push({
        organizationId: lead.organizationId,
        leadId: lead.id,
        type: event.type,
        actorId: event.actorId,
        actorNameSnapshot: event.actorId
          ? (staffName.get(event.actorId) ?? null)
          : null,
        metadata: { ...event.metadata, derived: true },
        createdAt: event.createdAt,
      });
    }
  }

  const unattributed = rows.filter((r) => !r.actorId).length;

  console.log(
    [
      `Leads scanned:            ${allLeads.length}`,
      `Already had activity:     ${alreadyBackfilled.size}`,
      `Leads to backfill:        ${leadsWithEvents}`,
      `Events to insert:         ${rows.length}`,
      `  ...with a known actor:  ${rows.length - unattributed}`,
      `  ...actor unknowable:    ${unattributed}`,
      "",
      "stage_changed is not backfilled: stage transitions were never",
      "timestamped, so time-in-stage stays insufficient_data for these leads.",
    ].join("\n"),
  );

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  if (rows.length === 0) return;

  // Chunked so a large firm doesn't build one enormous statement.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(leadEvents).values(rows.slice(i, i + CHUNK));
  }

  console.log(`\nInserted ${rows.length} events.`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
