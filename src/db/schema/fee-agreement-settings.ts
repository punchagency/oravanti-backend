import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { staff } from "./staff";

/**
 * Who signs first when a fee agreement carries both signatures.
 *
 * `client_first` is the default because it is the counter-signature the firm
 * actually asked for: the client commits, and the attorney executes a document
 * they have seen the client accept. `firm_first` exists for firms that would
 * rather the client only ever sees a document already executed on the firm's
 * side — the client's email is then held until the attorney has signed.
 *
 * Dropbox Sign enforces this through the signer `order` field: signer 2's sign
 * URL is not released until signer 1 has signed. Nothing in our own code has to
 * police the sequence.
 */
export const feeAgreementSigningOrderEnum = pgEnum(
  "fee_agreement_signing_order",
  ["client_first", "firm_first"],
);

export const feeAgreementSettings = pgTable("fee_agreement_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),
  /**
   * Whether the firm counter-signs at all.
   *
   * Defaults true: a retainer the firm never signed is the thing this table
   * exists to fix, so counter-signing is the flow and opting out is the
   * decision. A firm that turns it off gets exactly the behaviour that shipped
   * before this table existed — the single-signer path is not a special case
   * bolted on for them, it is the same code path an agreement already out for
   * signature keeps running (see `fee_agreements.firm_signer_signature_id`).
   */
  requiresFirmSignature: boolean("requires_firm_signature")
    .notNull()
    .default(true),
  signingOrder: feeAgreementSigningOrderEnum("signing_order")
    .notNull()
    .default("client_first"),
  /**
   * Whether the invoice waits for the firm's signature.
   *
   * True — the default — means nothing is billed until the agreement is fully
   * executed, which is the point of counter-signing: the firm should not be
   * asking for money against a contract it has not signed. False bills on the
   * client's signature and lets the counter-signature trail behind, for firms
   * whose attorneys sign in batches and who would rather not hold up cash.
   *
   * Either way the case-opening gate still requires full execution — this
   * governs when the client is asked to pay, not when the matter opens.
   */
  invoiceWaitsForFirmSignature: boolean("invoice_waits_for_firm_signature")
    .notNull()
    .default(true),
  /**
   * Whether whoever runs the generation wizard may pick a signer other than the
   * resolved default. Off locks every agreement to the consultation attorney
   * (or the fallbacks below), which is what a firm wanting a strict signing
   * authority policy needs.
   */
  allowSignerOverride: boolean("allow_signer_override").notNull().default(true),
  /**
   * The firm's fallback signer, used when the consultation attorney does not
   * hold `fee_agreements:sign`. Null falls through to the organization owner,
   * who always holds it.
   */
  defaultSignerStaffId: uuid("default_signer_staff_id").references(
    () => staff.id,
  ),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// No CHECK coupling the last four columns to `requiresFirmSignature`, unlike
// the deposit/schedule pairs on `consultation_settings`. Those columns are
// meaningless without their schedule; these are merely dormant, and a firm that
// switches counter-signing off and back on should find its configuration intact
// rather than nulled out by the round trip.

export type FeeAgreementSettings = typeof feeAgreementSettings.$inferSelect;
export type NewFeeAgreementSettings = typeof feeAgreementSettings.$inferInsert;
