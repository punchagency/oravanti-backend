import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { leads } from "./leads";
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { practiceAreas } from "./practice-areas";

// Structured fee-agreement form data captured before generation.
export type FeeAgreementDetails = {
  attorneyFee: {
    type: "flat" | "hourly" | "flat_hourly";
    flatRate?: number;
    hourlyRate?: number;
  };
  governmentFees: { name: string; amount: number }[];
  paymentPlan: "pay_in_full" | "two_payments" | "installments";
  applyConsultationCredit: boolean;
  accountSplit: { operating: number; trust: number };
  consultationFeeAmount: number | null;
  docRef: string;
};

export const feeAgreementGeneratedFromEnum = pgEnum(
  "fee_agreement_generated_from",
  ["questionnaire_auto", "manual"],
);

export const feeAgreementStatusEnum = pgEnum("fee_agreement_status", [
  "draft",
  "pending_signature",
  "signed",
  "voided",
]);

export const feeAgreements = pgTable("fee_agreements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  practiceAreaId: uuid("practice_area_id").references(() => practiceAreas.id),
  caseTypeId: uuid("case_type_id").references(() => practiceAreaCaseTypes.id),
  agreementType: text("agreement_type"),
  // Structured form captured before generation (attorney/government fees,
  // payment plan, consultation credit, account split, docRef).
  details: jsonb("details").$type<FeeAgreementDetails>(),
  generatedFrom: feeAgreementGeneratedFromEnum("generated_from")
    .notNull()
    .default("questionnaire_auto"),
  status: feeAgreementStatusEnum("status").notNull().default("draft"),
  documentUrl: text("document_url"),
  envelopeId: text("envelope_id"),
  signingLink: text("signing_link"),
  clientSignedAt: timestamp("client_signed_at"),
  nudgedAt: timestamp("nudged_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FeeAgreement = typeof feeAgreements.$inferSelect;
export type NewFeeAgreement = typeof feeAgreements.$inferInsert;
