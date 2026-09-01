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
import { staff } from "./staff";

// Structured fee-agreement form data captured before generation.
// Every field added after the initial release is optional so that rows
// generated before it deserialize unchanged and render byte-identically.
export type FeeAgreementDetails = {
  attorneyFee: {
    // "contingency" = pure contingency: no upfront attorney fee, only a
    // percentage of the settlement.
    type: "flat" | "hourly" | "flat_hourly" | "contingency";
    // Flat total, or the initial retainer for flat_hourly.
    flatRate?: number;
    hourlyRate?: number;
    // Estimated hours for hourly agreements (summary/prose only; billing
    // remains actual-hours).
    estimatedHours?: number;
    // Settlement percentage, combinable with any type; required when
    // type === "contingency". 0 < x <= 100.
    contingencyPercent?: number;
  };
  // Present only on contingency agreements created by the wizard.
  contingencyTerms?: {
    coversCaseCosts: boolean;
    coversExpertWitnessFees: boolean;
    ifLost: "client_owes_nothing" | "client_reimburses_hard_costs";
    // Server-stamped ISO timestamp of when the attorney checked all three
    // ABA Rule 1.5(c) confirmation boxes in the wizard.
    abaConfirmedAt: string;
  };
  governmentFees: { name: string; amount: number }[];
  // "Other costs & disbursements" (operating account). Only rows the attorney
  // included are persisted.
  otherCosts?: { name: string; amount: number }[];
  // Who fronts government fees. Absent on old rows → treated as "client_upfront".
  governmentFeesPaidBy?: "client_upfront" | "firm_advanced";
  paymentPlan: "pay_in_full" | "two_payments" | "installments";
  /**
   * How the firm collects what this agreement charges upfront.
   *
   * Mirrors `consultations.payment_timing`, deliberately — a firm that takes a
   * card at signing for consultations does the same for retainers, and two
   * vocabularies for one question would be two things to keep in step.
   *
   *   pay_at_signing — the invoice is emailed the moment the agreement is
   *                    signed, and the signing page offers to take payment
   *                    there and then
   *   invoice_after  — put on the books at signing but not emailed; staff send
   *                    it from Finance when they are ready
   *   pay_in_person  — never emailed; staff attest the payment when it arrives
   *
   * Absent on rows generated before this existed → treated as
   * `pay_at_signing`. Safe because sending only ever happens inside
   * `billSignedFeeAgreement`, which runs at signing: an agreement signed before
   * this shipped never re-enters that path and is never retroactively billed.
   */
  paymentTiming?: "pay_at_signing" | "invoice_after" | "pay_in_person";
  // Concrete schedules — present iff the matching paymentPlan was chosen.
  twoPaymentsSchedule?: {
    // First payment is due at signing.
    firstAmount: number;
    secondAmount: number;
    secondDueDate: string; // date-only "YYYY-MM-DD"
  };
  installmentSchedule?: {
    monthlyAmount: number;
    numberOfPayments: number; // months
    firstPaymentDate: string; // date-only "YYYY-MM-DD"
  };
  // How payments are applied between attorney fees and costs. The costs share
  // is always derived as 100 − customFeePercent, never stored.
  paymentAllocation?: {
    order: "fees_first" | "costs_first" | "custom";
    customFeePercent?: number;
  };
  applyConsultationCredit: boolean;
  accountSplit: { operating: number; trust: number };
  consultationFeeAmount: number | null;
  docRef: string;
  // The one field mutated after generation: staff marked the upfront payment
  // received (case-opening gate for non-contingency agreements).
  paymentReceivedAt?: string;
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
    .references(() => leads.id, { onDelete: "cascade" }),
  /**
   * What the agreement is about, snapshotted off the lead at generation —
   * NOT a pointer to be dereferenced through `leads` at read time, which is
   * mutable and would silently restate a signed document the moment someone
   * re-classified the lead behind it.
   *
   * `generateFeeAgreement` is the single writer. Regeneration goes through it
   * too: `discardDraftFeeAgreement` hard-deletes the draft rather than updating
   * it, so a re-generated agreement re-snapshots from the lead as it stands
   * then, which is the intent.
   *
   * The FKs guarantee each id exists, NOT that the two agree — a case type
   * reaches its practice area only through its subcategory. They are consistent
   * here because the lead's own pair is validated by
   * `ensureCaseTypeIdBelongsToPracticeArea` and both are copied together.
   *
   * NOT NULL, like `cases.practice_area_id` and `cases.case_type_id` — the same
   * snapshot one pipeline stage further on — and like the `leads` columns they
   * are copied from. Existing rows were filled by
   * `npm run backfill:fee-agreement-classification`, which has to run before the
   * migration that adds the constraint.
   */
  practiceAreaId: uuid("practice_area_id")
    .notNull()
    .references(() => practiceAreas.id),
  caseTypeId: uuid("case_type_id")
    .notNull()
    .references(() => practiceAreaCaseTypes.id),
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
  /**
   * The invoice raised for what this agreement charges upfront, minted when it
   * is signed. Null when the agreement bills nothing then — a pure contingency
   * with firm-advanced costs — and on every agreement signed before invoicing
   * existed, which is why the case-opening gate falls back to
   * `details.paymentReceivedAt` rather than treating null as unpaid.
   *
   * Unlinked id, like `leads.clientId`: removing an invoice must not cascade
   * into the signed agreement it belonged to.
   */
  invoiceId: uuid("invoice_id"),
  nudgedAt: timestamp("nudged_at"),
  // Actors. The client signs via the provider, so there is no staff actor for
  // the signature itself — receivedById records who *marked* it received manually.
  generatedById: uuid("generated_by_id").references(() => staff.id),
  sentById: uuid("sent_by_id").references(() => staff.id),
  receivedById: uuid("received_by_id").references(() => staff.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FeeAgreement = typeof feeAgreements.$inferSelect;
export type NewFeeAgreement = typeof feeAgreements.$inferInsert;
