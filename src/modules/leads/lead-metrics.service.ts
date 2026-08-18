import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../../db/client";
import type { FeeAgreementDetails } from "../../db/schema/fee-agreements";
import { feeAgreements } from "../../db/schema/fee-agreements";
import { auditEvents } from "../../db/schema/audit-events";
import { leads } from "../../db/schema/leads";
import { practiceAreas } from "../../db/schema/practice-areas";


export type MetricsPeriod = "30d" | "90d" | "12mo";

const PERIOD_DAYS: Record<MetricsPeriod, number> = {
  "30d": 30,
  "90d": 90,
  "12mo": 365,
};

const STAGES = [
  "lead_inbox",
  "conflict_check",
  "questionnaire",
  "consultation",
  "fee_agreement",
  "case_opening",
] as const;

type Stage = (typeof STAGES)[number];

/**
 * A metric that cannot be computed is reported as such. It is never defaulted
 * to zero — a zero here would read as "no time spent in this stage", which is a
 * different and false claim.
 */
export type Measurable<T> =
  | { status: "ok"; value: T }
  | { status: "insufficient_data"; reason: string };

const periodStart = (period: MetricsPeriod): Date => {
  const start = new Date();
  start.setDate(start.getDate() - PERIOD_DAYS[period]);
  return start;
};

type CohortRow = {
  createdAt: Date;
  convertedAt: Date | null;
};

/**
 * Headline stats for a set of leads. Shared by the current window and the
 * preceding one of equal length, so the two are always computed identically.
 */
const summarise = (cohort: CohortRow[]) => {
  const totalLeads = cohort.length;

  // Conversion is keyed on convertedAt, not status: openCase writes status
  // "reviewed", never "converted", so a status-keyed metric would read zero.
  const converted = cohort.filter((l) => l.convertedAt !== null);
  const conversionRate =
    totalLeads > 0 ? (converted.length / totalLeads) * 100 : 0;

  const avgDaysToConvert: Measurable<number> =
    converted.length > 0
      ? {
          status: "ok",
          value:
            converted.reduce(
              (sum, l) =>
                sum +
                (l.convertedAt!.getTime() - l.createdAt.getTime()) /
                  (1000 * 60 * 60 * 24),
              0,
            ) / converted.length,
        }
      : {
          status: "insufficient_data",
          reason: "No leads from this period have converted yet",
        };

  return {
    totalLeads,
    convertedLeads: converted.length,
    conversionRate,
    avgDaysToConvert,
  };
};

/**
 * The contracted value of an agreement, where the agreement itself determines
 * one.
 *
 * Hourly fees are excluded deliberately: `estimatedHours` is documented as
 * summary/prose only, with billing on actual hours, so multiplying it out would
 * invent revenue that no one has agreed to pay. Contingency fees are excluded
 * because their value is a share of a settlement that has not happened yet.
 * Both are counted and surfaced so the number is legible rather than silently
 * partial.
 */
const contractedValue = (details: FeeAgreementDetails | null): number | null => {
  const fee = details?.attorneyFee;
  if (!fee) return null;

  switch (fee.type) {
    case "flat":
    case "flat_hourly":
      // flat_hourly's flatRate is the initial retainer — a real, agreed amount.
      return fee.flatRate ?? null;
    case "hourly":
    case "contingency":
      return null;
  }
};

export const getLeadMetrics = async (
  organizationId: string,
  period: MetricsPeriod = "30d",
) => {
  const since = periodStart(period);

  // The equal-length window immediately before this one, so "vs previous
  // period" compares like with like.
  const previousSince = new Date(since);
  previousSince.setDate(previousSince.getDate() - PERIOD_DAYS[period]);

  const selection = {
    id: leads.id,
    source: leads.source,
    status: leads.status,
    pipelineStage: leads.pipelineStage,
    createdAt: leads.createdAt,
    convertedAt: leads.convertedAt,
    feeAgreementId: leads.feeAgreementId,
  };

  const [cohort, previousCohort] = await Promise.all([
    db
      .select(selection)
      .from(leads)
      .where(
        and(
          eq(leads.organizationId, organizationId),
          gte(leads.createdAt, since),
        ),
      ),
    db
      .select(selection)
      .from(leads)
      .where(
        and(
          eq(leads.organizationId, organizationId),
          gte(leads.createdAt, previousSince),
          lt(leads.createdAt, since),
        ),
      ),
  ]);

  const leadIds = cohort.map((l) => l.id);

  const current = summarise(cohort);
  const { totalLeads, convertedLeads, conversionRate, avgDaysToConvert } =
    current;
  const converted = cohort.filter((l) => l.convertedAt !== null);

  // Returned raw rather than as a delta so the UI can tell "no change" apart
  // from "there was no previous period to compare against" — a firm's first
  // month must not report a triumphant +100%.
  const previous = summarise(previousCohort);

  // ─── Funnel ────────────────────────────────────────────────────────────────
  // Stages are ordinal and a lead never regresses, so "reached stage N" is
  // every lead currently at N or beyond. A lead that stalls (archived, declined)
  // is counted at the furthest stage it actually got to, which is what a funnel
  // should show.
  const active = cohort.filter((l) => l.status !== "declined");
  const funnel = STAGES.map((stage, i) => {
    const reached = active.filter(
      (l) => STAGES.indexOf(l.pipelineStage as Stage) >= i,
    ).length;
    return { stage, reached };
  }).map((entry, i, all) => ({
    ...entry,
    droppedOff: i === 0 ? 0 : all[i - 1].reached - entry.reached,
  }));

  // ─── Time in stage ─────────────────────────────────────────────────────────
  // Derived from stage_changed events, which only began accruing when the
  // activity trail shipped. Leads that predate it have no intervals, and stages
  // no lead has yet left have none either — both report insufficient_data
  // rather than a fabricated average.
  const stageEvents = leadIds.length
    ? await db
        .select({
          leadId: auditEvents.entityId,
          metadata: auditEvents.metadata,
          createdAt: auditEvents.occurredAt,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityType, "lead"),
            eq(auditEvents.action, "lead.stage_changed"),
            inArray(auditEvents.entityId, leadIds),
          ),
        )
        .orderBy(asc(auditEvents.occurredAt))
    : [];

  const durationsByStage = new Map<Stage, number[]>();
  const enteredAt = new Map<string, { stage: Stage; at: Date }>();

  // A lead enters lead_inbox when it is created; every later entry is an event.
  for (const lead of cohort) {
    enteredAt.set(lead.id, { stage: "lead_inbox", at: lead.createdAt });
  }

  for (const event of stageEvents) {
    const meta = event.metadata as { from?: string; to?: string } | null;
    // `entity_id` is nullable on audit_events — it holds no foreign key, so
    // nothing guarantees it at the database level. A stage change without a
    // lead cannot contribute an interval.
    if (!event.leadId || !meta?.from || !meta?.to) continue;

    const entry = enteredAt.get(event.leadId);
    if (entry && entry.stage === meta.from) {
      const ms = event.createdAt.getTime() - entry.at.getTime();
      const list = durationsByStage.get(entry.stage) ?? [];
      list.push(ms);
      durationsByStage.set(entry.stage, list);
    }

    enteredAt.set(event.leadId, {
      stage: meta.to as Stage,
      at: event.createdAt,
    });
  }

  const avgDaysInStage: Record<Stage, Measurable<number>> = Object.fromEntries(
    STAGES.map((stage) => {
      const durations = durationsByStage.get(stage);
      if (!durations?.length) {
        return [
          stage,
          {
            status: "insufficient_data",
            reason:
              "No lead in this period has completed this stage since activity tracking began",
          },
        ];
      }
      const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      return [
        stage,
        { status: "ok", value: avgMs / (1000 * 60 * 60 * 24) },
      ];
    }),
  ) as Record<Stage, Measurable<number>>;

  // ─── Leads by source ───────────────────────────────────────────────────────
  const bySource = new Map<string, { total: number; converted: number }>();
  for (const lead of cohort) {
    const entry = bySource.get(lead.source) ?? { total: 0, converted: 0 };
    entry.total += 1;
    if (lead.convertedAt) entry.converted += 1;
    bySource.set(lead.source, entry);
  }
  const leadsBySource = [...bySource.entries()]
    .map(([source, v]) => ({
      source,
      total: v.total,
      converted: v.converted,
      conversionRate: v.total > 0 ? (v.converted / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // ─── Conversion by practice area ───────────────────────────────────────────
  const areaRows = leadIds.length
    ? await db
        .select({
          leadId: leads.id,
          practiceAreaId: practiceAreas.id,
          practiceAreaName: practiceAreas.name,
        })
        .from(leads)
        .innerJoin(practiceAreas, eq(leads.practiceAreaId, practiceAreas.id))
        .where(inArray(leads.id, leadIds))
    : [];

  const convertedIds = new Set(converted.map((l) => l.id));
  const byArea = new Map<
    string,
    { name: string; total: number; converted: number }
  >();
  for (const row of areaRows) {
    const entry = byArea.get(row.practiceAreaId) ?? {
      name: row.practiceAreaName,
      total: 0,
      converted: 0,
    };
    entry.total += 1;
    if (convertedIds.has(row.leadId)) entry.converted += 1;
    byArea.set(row.practiceAreaId, entry);
  }
  const conversionByPracticeArea = [...byArea.entries()]
    .map(([practiceAreaId, v]) => ({
      practiceAreaId,
      practiceAreaName: v.name,
      total: v.total,
      converted: v.converted,
      conversionRate: v.total > 0 ? (v.converted / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // ─── Contracted value of signed agreements ─────────────────────────────────
  const signedAgreements = await db
    .select({
      id: feeAgreements.id,
      details: feeAgreements.details,
    })
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.organizationId, organizationId),
        eq(feeAgreements.status, "signed"),
        isNotNull(feeAgreements.clientSignedAt),
        gte(feeAgreements.clientSignedAt, since),
      ),
    );

  let determinableTotal = 0;
  let determinableCount = 0;
  const excluded = { hourly: 0, contingency: 0 };

  for (const agreement of signedAgreements) {
    const value = contractedValue(agreement.details);
    if (value !== null) {
      determinableTotal += value;
      determinableCount += 1;
      continue;
    }
    const type = agreement.details?.attorneyFee?.type;
    if (type === "hourly") excluded.hourly += 1;
    else if (type === "contingency") excluded.contingency += 1;
  }

  return {
    period,
    since: since.toISOString(),
    totalLeads,
    convertedLeads,
    conversionRate,
    avgDaysToConvert,
    previous,
    funnel,
    avgDaysInStage,
    leadsBySource,
    conversionByPracticeArea,
    // Named "contracted value", not "revenue": it is what clients have agreed
    // to pay on signed agreements, not what the firm has collected.
    contractedValue: {
      total: determinableTotal,
      agreementsCounted: determinableCount,
      // Real signed agreements whose value the agreement itself does not fix.
      // Surfaced so a low total is legible as "partial", not read as "low".
      agreementsExcluded: excluded,
    },
  };
};
