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
  // R2 key of the generated (unsigned) PDF sent for signature.
  documentUrl: text("document_url"),
  // Dropbox Sign signature_request_id (reused from the stub's envelope concept).
  envelopeId: text("envelope_id"),
  signingLink: text("signing_link"),
  // Dropbox Sign signature_id for the client signer; used to mint fresh embedded
  // sign URLs on demand (they expire ~60 min).
  signerSignatureId: text("signer_signature_id"),
  // Opaque token for the public client-facing signing page URL, so the client
  // link never exposes the agreement id or signature id.
  signingToken: text("signing_token").unique(),
  // R2 key of the final signed PDF downloaded from Dropbox Sign after completion.
  signedDocumentUrl: text("signed_document_url"),
  // Last raw provider event type + timestamp, for observability.
  providerStatus: text("provider_status"),
  lastWebhookEventAt: timestamp("last_webhook_event_at"),
  clientSignedAt: timestamp("client_signed_at"),
  nudgedAt: timestamp("nudged_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FeeAgreement = typeof feeAgreements.$inferSelect;
export type NewFeeAgreement = typeof feeAgreements.$inferInsert;
