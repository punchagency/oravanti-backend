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
  feeLines: { description: string; amount: number }[];
  totalDue: number;
  allocation: { operating: number; trust: number; total: number };
  paymentPlan: "pay_in_full" | "two_payments" | "installments";
  applyConsultationCredit: boolean;
  consultationFeeAmount: number | null;
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
      name: leads.name,
      caseTypeName: practiceAreaCaseTypes.name,
      consultationId: leads.consultationId,
      assignedStaffId: leads.assignedStaffId,
    })
    .from(leads)
    .leftJoin(
      practiceAreaCaseTypes,
      eq(leads.caseTypeId, practiceAreaCaseTypes.id),
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

  const feeLines: { description: string; amount: number }[] = [];
  const af = details?.attorneyFee;
  if (af) {
    const flat = af.flatRate ?? 0;
    const hourly = af.hourlyRate ?? 0;
    if (af.type === "flat") {
      feeLines.push({ description: `Legal services — ${matterType}`, amount: flat });
    } else if (af.type === "hourly") {
      feeLines.push({
        description: `Legal services (billed at $${hourly}/hr) — ${matterType}`,
        amount: 0,
      });
    } else {
      feeLines.push({
        description: `Legal services ($${flat} + $${hourly}/hr) — ${matterType}`,
        amount: flat,
      });
    }
  }
  for (const g of details?.governmentFees ?? []) {
    feeLines.push({
      description: caseCode ? `${g.name} (${caseCode})` : g.name,
      amount: g.amount,
    });
  }
  const totalDue = feeLines.reduce((sum, l) => sum + l.amount, 0);

  const operating = details?.accountSplit.operating ?? 0;
  const trust = details?.accountSplit.trust ?? 0;

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
    client: { name: lead?.name ?? "Client", matterType },
    feeLines,
    totalDue,
    allocation: { operating, trust, total: operating + trust },
    paymentPlan: details?.paymentPlan ?? "pay_in_full",
    applyConsultationCredit: details?.applyConsultationCredit ?? false,
    consultationFeeAmount: details?.consultationFeeAmount ?? null,
  };
};
