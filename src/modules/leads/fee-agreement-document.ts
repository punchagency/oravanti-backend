import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { consultations } from "../../db/schema/consultations";
import { feeAgreements } from "../../db/schema/fee-agreements";
import { leads } from "../../db/schema/leads";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { staff } from "../../db/schema/staff";
import { FirmInfoService } from "../settings/firm-info/firm-info.service";

const firmInfoService = new FirmInfoService();

export type FeeAgreementDocument = {
  docRef: string;
  datePrepared: string; // ISO
  firm: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    phone: string | null;
    email: string | null;
  };
  attorneyName: string;
  client: { name: string; matterType: string };
  // amount null renders as "—" (contingency line); deferred lines (contingency,
  // firm-advanced government fees) are excluded from totalDue.
  feeLines: { description: string; amount: number | null; deferred?: boolean }[];
  totalDue: number; // sum of non-deferred lines — i.e. due upfront
  allocation: { operating: number; trust: number; total: number };
  paymentPlan: "pay_in_full" | "two_payments" | "installments";
  applyConsultationCredit: boolean;
  consultationFeeAmount: number | null;
  contingencyPercent: number | null;
  governmentFeesPaidBy: "client_upfront" | "firm_advanced";
  // True when nothing is due upfront (pure contingency + no client-paid
  // government fees) — renderers hide the payment plan / account allocation.
  noUpfrontDue: boolean;
  // Wizard-era fields — all null on agreements generated before the 3-step
  // wizard, so every renderer branch keyed on them is a no-op for old rows.
  estimatedHours: number | null;
  twoPaymentsSchedule: {
    firstAmount: number;
    secondAmount: number;
    secondDueDate: string; // "YYYY-MM-DD"
  } | null;
  installmentSchedule: {
    monthlyAmount: number;
    numberOfPayments: number;
    firstPaymentDate: string; // "YYYY-MM-DD"
  } | null;
  paymentAllocation: {
    order: "fees_first" | "costs_first" | "custom";
    customFeePercent: number | null;
  } | null;
  contingencyTerms: {
    coversCaseCosts: boolean;
    coversExpertWitnessFees: boolean;
    ifLost: "client_owes_nothing" | "client_reimburses_hard_costs";
    abaConfirmedAt: string;
  } | null;
};

// Assembles the dynamic data for the fee-agreement preview document. The static
// legal prose (scope, payment terms, T&C, disclaimer) is composed on the client
// from this payload. Self-contained (looks up lead/attorney/firm) so both the
// generate and the preview endpoints can reuse it from just the agreement row.
export const assembleFeeAgreementDocument = async (
  agreement: typeof feeAgreements.$inferSelect,
  organizationId: string,
): Promise<FeeAgreementDocument> => {
  const details = agreement.details;

  const [lead] = await db
    .select({
      firstName: leads.firstName,
      lastName: leads.lastName,
      caseTypeName: practiceAreaCaseTypes.name,
      consultationId: leads.consultationId,
      assignedStaffId: leads.respondentId,
    })
    .from(leads)
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, leads.caseTypeId),
    )
    .where(eq(leads.id, agreement.leadId))
    .limit(1);

  const matterType = lead?.caseTypeName ?? "Not specified";
  // Case code = the token before the em/en dash, e.g. "I-130 — Petition…" → "I-130".
  const caseCode = matterType.split(/\s[—–-]\s/)[0]?.trim() ?? "";

  // Attorney = the lead's consultation attorney, else the assigned staff.
  let attorneyStaffId: string | null = null;
  if (lead?.consultationId) {
    const [c] = await db
      .select({ leadAttorneyId: consultations.leadAttorneyId })
      .from(consultations)
      .where(eq(consultations.id, lead.consultationId))
      .limit(1);
    attorneyStaffId = c?.leadAttorneyId ?? null;
  }
  attorneyStaffId = attorneyStaffId ?? lead?.assignedStaffId ?? null;

  let attorneyName = "Assigned attorney";
  if (attorneyStaffId) {
    const [s] = await db
      .select({ firstName: staff.firstName, lastName: staff.lastName })
      .from(staff)
      .where(eq(staff.id, attorneyStaffId))
      .limit(1);
    if (s) attorneyName = `${s.firstName} ${s.lastName}`.trim();
  }

  const firm = await firmInfoService.getFirmInfo(organizationId);

  const feeLines: {
    description: string;
    amount: number | null;
    deferred?: boolean;
  }[] = [];
  const af = details?.attorneyFee;
  const contingencyPercent = af?.contingencyPercent ?? null;
  if (af) {
    const flat = af.flatRate ?? 0;
    const hourly = af.hourlyRate ?? 0;
    if (af.type === "flat") {
      feeLines.push({ description: `Legal services — ${matterType}`, amount: flat });
    } else if (af.type === "hourly") {
      // Estimated hours only appear on wizard-era agreements; older rows keep
      // the original description verbatim.
      feeLines.push({
        description:
          af.estimatedHours != null
            ? `Legal services (billed at $${hourly}/hr, estimated ${af.estimatedHours} hours) — ${matterType}`
            : `Legal services (billed at $${hourly}/hr) — ${matterType}`,
        amount: 0,
      });
    } else if (af.type === "flat_hourly") {
      feeLines.push({
        description: `Legal services ($${flat} + $${hourly}/hr) — ${matterType}`,
        amount: flat,
      });
    } else {
      // Pure contingency: no upfront attorney fee.
      feeLines.push({
        description: `Legal services (contingency — ${contingencyPercent}% of settlement) — ${matterType}`,
        amount: null,
        deferred: true,
      });
    }
    // Settlement percentage added on top of an upfront fee structure.
    if (af.type !== "contingency" && contingencyPercent != null) {
      feeLines.push({
        description: `Contingency fee — ${contingencyPercent}% of settlement or award`,
        amount: null,
        deferred: true,
      });
    }
  }
  const governmentFeesPaidBy = details?.governmentFeesPaidBy ?? "client_upfront";
  const govDeferred = governmentFeesPaidBy === "firm_advanced";
  for (const g of details?.governmentFees ?? []) {
    const name = caseCode ? `${g.name} (${caseCode})` : g.name;
    feeLines.push({
      description: govDeferred ? `${name} — advanced by firm` : name,
      amount: g.amount,
      ...(govDeferred ? { deferred: true } : {}),
    });
  }
  // Other costs & disbursements (wizard-era; absent on old rows). Under a
  // contingency arrangement the firm advances them, so they defer like
  // firm-advanced government fees and feed the same Advanced-costs section.
  const otherDeferred = af?.type === "contingency";
  for (const c of details?.otherCosts ?? []) {
    feeLines.push({
      description: otherDeferred
        ? `${c.name} — other costs, advanced by firm`
        : `${c.name} — other costs`,
      amount: c.amount,
      ...(otherDeferred ? { deferred: true } : {}),
    });
  }
  const totalDue = feeLines
    .filter((l) => !l.deferred)
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

  const noUpfrontDue =
    af?.type === "contingency" &&
    ((details?.governmentFees ?? []).length === 0 || govDeferred);

  const operating = noUpfrontDue ? 0 : (details?.accountSplit.operating ?? 0);
  const trust = noUpfrontDue ? 0 : (details?.accountSplit.trust ?? 0);

  return {
    docRef: details?.docRef ?? "",
    datePrepared: agreement.createdAt.toISOString(),
    firm: {
      name: firm?.firmName ?? "Your law firm",
      address: firm?.address ?? null,
      city: firm?.city ?? null,
      state: firm?.state ?? null,
      zipCode: firm?.zipCode ?? null,
      phone: firm?.firmPhone ?? null,
      email: firm?.firmEmail ?? null,
    },
    attorneyName,
    client: { name: lead ? `${lead.firstName} ${lead.lastName}` : "Client", matterType },
    feeLines,
    totalDue,
    allocation: { operating, trust, total: operating + trust },
    paymentPlan: details?.paymentPlan ?? "pay_in_full",
    applyConsultationCredit: details?.applyConsultationCredit ?? false,
    consultationFeeAmount: details?.consultationFeeAmount ?? null,
    contingencyPercent,
    governmentFeesPaidBy,
    noUpfrontDue,
    estimatedHours: af?.estimatedHours ?? null,
    twoPaymentsSchedule: details?.twoPaymentsSchedule ?? null,
    installmentSchedule: details?.installmentSchedule ?? null,
    paymentAllocation: details?.paymentAllocation
      ? {
          order: details.paymentAllocation.order,
          customFeePercent: details.paymentAllocation.customFeePercent ?? null,
        }
      : null,
    contingencyTerms: details?.contingencyTerms ?? null,
  };
};
