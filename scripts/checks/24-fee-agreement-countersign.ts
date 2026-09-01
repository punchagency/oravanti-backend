/**
 * The firm signs its own retainers, and only the right person can.
 *
 * A fee agreement used to be executed by one party. The client signed, an
 * invoice went out, and the firm's side of the document was a printed blank —
 * so the firm was billing against a contract nobody there had signed.
 *
 * The counter-signature adds a second signer, and with it three things that can
 * go wrong quietly:
 *
 *   - the wrong person signs, because eligibility was read off a role name
 *     rather than a real grant;
 *   - the money moves at the wrong moment, because "signed" stopped meaning
 *     "fully executed" somewhere it still had to;
 *   - an agreement already at the provider with one signer breaks, because the
 *     new path assumed a second one it can never have.
 *
 * This asserts all three, plus the redelivery behaviour the whole flow rests on:
 * Dropbox Sign retries, so the per-signature event is read as a snapshot and
 * must be inert the second time.
 *
 * Runs against the TEST database (npm run check 24-fee-agreement-countersign)
 * and cleans up the org it creates.
 */
import { createHmac, randomUUID } from "crypto";
import { env } from "../../src/config/env";
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import {
  member,
  organization,
  organizationRole,
  user,
} from "../../src/db/schema/auth-schema";
import { seedDefaultRoleRows } from "../../src/auth/seed-default-roles";
import { consultations } from "../../src/db/schema/consultations";
import { feeAgreementSettings } from "../../src/db/schema/fee-agreement-settings";
import { feeAgreements } from "../../src/db/schema/fee-agreements";
import { leads } from "../../src/db/schema/leads";
import { invoiceDeliveries } from "../../src/db/schema/invoice-deliveries";
import { invoiceInstalments } from "../../src/db/schema/invoice-instalments";
import { invoiceLineItems, invoices } from "../../src/db/schema/invoices";
import { invoiceNumberSequences } from "../../src/db/schema/invoice-number-sequences";
import { invoicePayments } from "../../src/db/schema/invoice-payments";
import { notifications } from "../../src/db/schema/notifications";
import { auditEvents } from "../../src/db/schema/audit-events";
import { practiceAreaCaseTypes } from "../../src/db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../src/db/schema/practice-area-subcategories";
import { practiceAreas } from "../../src/db/schema/practice-areas";
import { staff } from "../../src/db/schema/staff";
import { listUserIdsWithGrant } from "../../src/modules/shared/member-grants.service";
import {
  listEligibleSigners,
  resolveDefaultFirmSigner,
} from "../../src/modules/settings/fee-agreements/fee-agreement-settings.service";
import {
  check,
  checkEqual,
  report,
  section,
  silenceEmail,
  withOrgContext,
} from "./_bootstrap";

/**
 * Force the stub e-signature provider, whatever the machine has configured.
 *
 * This check drives the state machine from webhooks it writes itself, which
 * means the database says the client has signed while Dropbox Sign knows
 * nothing about it. Against real credentials the provider then — correctly —
 * refuses to release the second signer's URL and refuses to hand over a
 * completed PDF, and the check fails on the provider being right rather than on
 * anything of ours being wrong.
 *
 * `getESignatureProvider` picks and caches on first call, so clearing the keys
 * here (before anything touches it) is enough. What is under test is our own
 * sequencing, not Dropbox Sign's — theirs is verified by
 * `npm run check 14-confido-sandbox`'s live counterpart and, in practice, by the
 * 409 this check would otherwise trip over.
 */
const forceStubProvider = () => {
  const mutable = env as { DROPBOX_SIGN_API_KEY?: string; DROPBOX_SIGN_CLIENT_ID?: string };
  mutable.DROPBOX_SIGN_API_KEY = undefined;
  mutable.DROPBOX_SIGN_CLIENT_ID = undefined;
};

/** A Dropbox Sign callback, as the controller hands it to the service. */
const signEvent = (
  eventType: string,
  signatureRequestId: string,
  signatures: { signature_id: string; signed_at: number | null }[],
) => {
  const eventTime = String(Math.floor(Date.now() / 1000));
  const apiKey = env.DROPBOX_SIGN_API_KEY;
  return {
    event: {
      event_time: eventTime,
      event_type: eventType,
      // The stub verifies everything, but sign it properly anyway so this stays
      // correct if the check is ever pointed at a real provider.
      event_hash: apiKey
        ? createHmac("sha256", apiKey).update(eventTime + eventType).digest("hex")
        : "stub",
    },
    signature_request: { signature_request_id: signatureRequestId, signatures },
  };
};

const main = async () => {
  forceStubProvider();
  silenceEmail();

  const suffix = randomUUID().slice(0, 8);
  const orgId = `check-org-${suffix}`;
  const ownerUserId = `check-owner-${suffix}`;
  const attorneyUserId = `check-attorney-${suffix}`;
  const paralegalUserId = `check-paralegal-${suffix}`;
  const now = new Date();

  const createdAreas: string[] = [];
  const createdSubs: string[] = [];
  const createdTypes: string[] = [];
  // Assigned from the staff rows seeded below; no meaningful initial value.
  let ownerStaffId: string;
  let attorneyStaffId: string;
  let paralegalStaffId: string;

  try {
    await systemDb.insert(user).values(
      [
        { id: ownerUserId, name: "Check Owner" },
        { id: attorneyUserId, name: "Check Attorney" },
        { id: paralegalUserId, name: "Check Paralegal" },
      ].map((u) => ({
        ...u,
        email: `${u.id}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await systemDb.insert(organization).values({
      id: orgId,
      name: `Check Org ${suffix}`,
      slug: `check-org-${suffix}`,
      createdAt: now,
    });

    // The four seeded default roles have to exist as real rows, or every member
    // holding one resolves to zero grants.
    await seedDefaultRoleRows(orgId);

    await systemDb.insert(member).values([
      { id: `m-owner-${suffix}`, organizationId: orgId, userId: ownerUserId, role: "owner", createdAt: now },
      { id: `m-att-${suffix}`, organizationId: orgId, userId: attorneyUserId, role: "attorney", createdAt: now },
      { id: `m-par-${suffix}`, organizationId: orgId, userId: paralegalUserId, role: "paralegal", createdAt: now },
    ]);

    const staffRows = await systemDb
      .insert(staff)
      .values([
        { organizationId: orgId, userId: ownerUserId, firstName: "Olive", lastName: `Owner ${suffix}`, orgEmail: `owner-${suffix}@example.test`, role: "owner" },
        { organizationId: orgId, userId: attorneyUserId, firstName: "Ada", lastName: `Attorney ${suffix}`, orgEmail: `attorney-${suffix}@example.test`, role: "attorney" },
        { organizationId: orgId, userId: paralegalUserId, firstName: "Pat", lastName: `Paralegal ${suffix}`, orgEmail: `paralegal-${suffix}@example.test`, role: "paralegal" },
      ])
      .returning();
    ownerStaffId = staffRows[0]!.id;
    attorneyStaffId = staffRows[1]!.id;
    paralegalStaffId = staffRows[2]!.id;

    // `practice_areas` is a global catalogue, not org-scoped.
    const [area] = await systemDb
      .insert(practiceAreas)
      .values({ name: `Check Area ${suffix}` })
      .returning();
    createdAreas.push(area!.id);
    const [sub] = await systemDb
      .insert(practiceAreaSubcategories)
      .values({ practiceAreaId: area!.id, code: `sub-${suffix}`, name: "Sub" })
      .returning();
    createdSubs.push(sub!.id);
    const [caseType] = await systemDb
      .insert(practiceAreaCaseTypes)
      .values({
        subcategoryId: sub!.id,
        code: `type-${suffix}`,
        name: `Matter ${suffix}`,
        caseNumberPrefix: "CHK",
        jurisdiction: "federal",
      })
      .returning();
    createdTypes.push(caseType!.id);

    const { LeadsService } = await import("../../src/modules/leads/leads.service");
    const svc = new LeadsService();
    const attorneyFee = { type: "flat" as const, flatRate: 1500 };

    /** A lead with a completed consultation, which generation is gated on. */
    const seedLead = async (leadAttorneyId: string | null) => {
      const [lead] = await systemDb
        .insert(leads)
        .values({
          organizationId: orgId,
          firstName: "Lee",
          lastName: `Lead ${randomUUID().slice(0, 6)}`,
          email: `lead-${randomUUID().slice(0, 6)}@example.test`,
          source: "direct",
          practiceAreaId: area!.id,
          caseTypeId: caseType!.id,
        })
        .returning();
      const [consultation] = await systemDb
        .insert(consultations)
        .values({
          organizationId: orgId,
          leadId: lead!.id,
          duration: 60,
          mode: "video",
          status: "completed",
          leadAttorneyId,
        })
        .returning();
      await systemDb
        .update(leads)
        .set({ consultationId: consultation!.id })
        .where(eq(leads.id, lead!.id));
      return lead!.id;
    };

    const rowOf = async (agreementId: string) => {
      const [row] = await systemDb
        .select()
        .from(feeAgreements)
        .where(eq(feeAgreements.id, agreementId))
        .limit(1);
      return row!;
    };

    // ── 1. Eligibility comes from grants ────────────────────────────────────
    section("Only real grant-holders can sign");

    const holders = await listUserIdsWithGrant(orgId, "fee_agreements:sign");
    check("the owner may sign", holders.has(ownerUserId));
    check("the attorney may sign", holders.has(attorneyUserId));
    check("the paralegal may not", !holders.has(paralegalUserId));

    const eligible = await listEligibleSigners(orgId);
    checkEqual("only those two are offered as signers", eligible.length, 2);

    // ── 2. Default signer resolution walks the fallbacks ────────────────────
    section("The default signer walks consultation attorney → firm default → owner");

    const attorneyLeadId = await seedLead(attorneyStaffId);
    checkEqual(
      "the consultation attorney signs when they may",
      await resolveDefaultFirmSigner(orgId, attorneyLeadId),
      attorneyStaffId,
    );

    const paralegalLeadId = await seedLead(paralegalStaffId);
    checkEqual(
      "a consultation attorney without the grant is skipped, and the owner signs",
      await resolveDefaultFirmSigner(orgId, paralegalLeadId),
      ownerStaffId,
    );

    await systemDb.insert(feeAgreementSettings).values({
      organizationId: orgId,
      defaultSignerStaffId: attorneyStaffId,
    });
    checkEqual(
      "the firm's configured fallback beats the owner",
      await resolveDefaultFirmSigner(orgId, paralegalLeadId),
      attorneyStaffId,
    );

    // ── 3. The two-signer flow ──────────────────────────────────────────────
    section("Client signs, then the firm counter-signs");

    const generated = await withOrgContext(orgId, ownerUserId, () =>
      svc.generateFeeAgreement(attorneyLeadId, orgId, { attorneyFee, generatedFrom: "manual" }, ownerStaffId),
    );
    const agreementId = generated.agreement.id;
    checkEqual(
      "generation records who signs for the firm",
      generated.agreement.firmSignerStaffId,
      attorneyStaffId,
    );

    await withOrgContext(orgId, ownerUserId, () =>
      svc.sendFeeAgreement(agreementId, orgId, ownerStaffId),
    );
    let row = await rowOf(agreementId);
    check("the client has a signature id", Boolean(row.signerSignatureId));
    check("and so does the firm signer", Boolean(row.firmSignerSignatureId));
    checkEqual("the signing order is snapshotted", row.signingOrder, "client_first");
    checkEqual(
      "and so is the invoice gate",
      row.invoiceWaitsForFirmSignature,
      true,
    );

    // Only the assigned signer, and only when it is their turn.
    let beforeTurn = false;
    try {
      await svc.getFirmSignSession(agreementId, orgId, attorneyStaffId);
    } catch {
      beforeTurn = true;
    }
    check("the firm cannot sign before the client has", beforeTurn);

    const clientSigned = signEvent("signature_request_signed", row.envelopeId!, [
      { signature_id: row.signerSignatureId!, signed_at: Math.floor(Date.now() / 1000) },
      { signature_id: row.firmSignerSignatureId!, signed_at: null },
    ]);
    await svc.handleDropboxSignWebhook(clientSigned as never);

    row = await rowOf(agreementId);
    check("the client's signature is recorded", Boolean(row.clientSignedAt));
    check("the firm's is not", row.firmSignedAt === null);
    checkEqual(
      "and the agreement is not yet executed",
      row.status,
      "pending_signature",
    );
    check(
      "no invoice is raised against an unexecuted agreement",
      row.invoiceId === null,
    );

    // Redelivery. Dropbox Sign retries, and the event is a snapshot rather than
    // a delta, so the second copy must change nothing.
    const firstSignedAt = row.clientSignedAt!.getTime();
    await svc.handleDropboxSignWebhook(clientSigned as never);
    row = await rowOf(agreementId);
    checkEqual(
      "a redelivered event does not move the signature time",
      row.clientSignedAt!.getTime(),
      firstSignedAt,
    );

    let wrongSigner = false;
    try {
      await svc.getFirmSignSession(agreementId, orgId, paralegalStaffId);
    } catch {
      wrongSigner = true;
    }
    check("somebody else cannot sign it", wrongSigner);

    const session = await svc.getFirmSignSession(agreementId, orgId, attorneyStaffId);
    check("the assigned signer gets a session once it is their turn", Boolean(session.signUrl));

    // No archived copy to hand out until it is executed.
    let noDocumentYet = false;
    try {
      await svc.getAgreementSignedDocument(row.signingToken!);
    } catch {
      noDocumentYet = true;
    }
    check("there is no signed copy to download before execution", noDocumentYet);

    await svc.handleDropboxSignWebhook(
      signEvent("signature_request_all_signed", row.envelopeId!, [
        { signature_id: row.signerSignatureId!, signed_at: Math.floor(Date.now() / 1000) },
        { signature_id: row.firmSignerSignatureId!, signed_at: Math.floor(Date.now() / 1000) },
      ]) as never,
    );

    row = await rowOf(agreementId);
    checkEqual("both signatures make it executed", row.status, "signed");
    check("the firm's signature is stamped", Boolean(row.firmSignedAt));
    check("the signed copy is archived", Boolean(row.signedDocumentUrl));
    checkEqual(
      "the client's original signing time survives the completion event",
      row.clientSignedAt!.getTime(),
      firstSignedAt,
    );

    const executedNotices = await systemDb
      .select({ id: notifications.id, payload: notifications.payload })
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, orgId),
          eq(notifications.event, "fee_agreement_executed"),
        ),
      );
    checkEqual(
      "the lead is sent exactly one executed copy",
      executedNotices.length,
      1,
    );

    // The contract travels with the email. Only the storage key is persisted —
    // the worker fetches the bytes at send time — so this is what "attached"
    // looks like from here.
    const executedPayload = (executedNotices[0]?.payload ?? {}) as Record<
      string,
      unknown
    >;
    const attached = (executedPayload["__attachments"] ??
      []) as { storageKey?: string }[];
    checkEqual(
      "the executed copy is attached to that email",
      attached[0]?.storageKey,
      row.signedDocumentUrl ?? undefined,
    );

    const signedDoc = await svc.getAgreementSignedDocument(row.signingToken!);
    check("and the link still works as a fallback", Boolean(signedDoc.url));

    // ── 4. Billing before the firm signs, when the firm asked for that ──────
    section("A firm that does not hold the invoice is billed on the client's signature");

    await systemDb
      .update(feeAgreementSettings)
      .set({ invoiceWaitsForFirmSignature: false })
      .where(eq(feeAgreementSettings.organizationId, orgId));

    const earlyLeadId = await seedLead(attorneyStaffId);
    const early = await withOrgContext(orgId, ownerUserId, () =>
      svc.generateFeeAgreement(earlyLeadId, orgId, { attorneyFee, generatedFrom: "manual" }, ownerStaffId),
    );
    await withOrgContext(orgId, ownerUserId, () =>
      svc.sendFeeAgreement(early.agreement.id, orgId, ownerStaffId),
    );
    let earlyRow = await rowOf(early.agreement.id);
    checkEqual(
      "the relaxed gate is snapshotted too",
      earlyRow.invoiceWaitsForFirmSignature,
      false,
    );

    await svc.handleDropboxSignWebhook(
      signEvent("signature_request_signed", earlyRow.envelopeId!, [
        { signature_id: earlyRow.signerSignatureId!, signed_at: Math.floor(Date.now() / 1000) },
        { signature_id: earlyRow.firmSignerSignatureId!, signed_at: null },
      ]) as never,
    );
    earlyRow = await rowOf(early.agreement.id);
    check(
      "the invoice is raised on the client's signature alone",
      earlyRow.invoiceId !== null,
    );
    checkEqual(
      "but the agreement is still not executed",
      earlyRow.status,
      "pending_signature",
    );

    // ── 5. Counter-signing turned off ───────────────────────────────────────
    section("A firm that does not counter-sign is unaffected");

    await systemDb
      .update(feeAgreementSettings)
      .set({ requiresFirmSignature: false })
      .where(eq(feeAgreementSettings.organizationId, orgId));

    const soloLeadId = await seedLead(attorneyStaffId);
    const solo = await withOrgContext(orgId, ownerUserId, () =>
      svc.generateFeeAgreement(soloLeadId, orgId, { attorneyFee, generatedFrom: "manual" }, ownerStaffId),
    );
    check(
      "no firm signer is assigned",
      solo.agreement.firmSignerStaffId === null,
    );

    await withOrgContext(orgId, ownerUserId, () =>
      svc.sendFeeAgreement(solo.agreement.id, orgId, ownerStaffId),
    );
    let soloRow = await rowOf(solo.agreement.id);
    check(
      "the request has one signer, which is what marks it single-signer forever",
      soloRow.firmSignerSignatureId === null,
    );
    check("and no order was snapshotted", soloRow.signingOrder === null);

    await svc.handleDropboxSignWebhook(
      signEvent("signature_request_all_signed", soloRow.envelopeId!, [
        { signature_id: soloRow.signerSignatureId!, signed_at: Math.floor(Date.now() / 1000) },
      ]) as never,
    );
    soloRow = await rowOf(solo.agreement.id);
    checkEqual("the client's signature alone executes it", soloRow.status, "signed");
    check(
      "and it never acquires a firm signature it did not have",
      soloRow.firmSignedAt === null,
    );
  } finally {
    // Billing really runs here, so the invoices it raised have to come out
    // before the leads they point at.
    await systemDb.delete(auditEvents).where(eq(auditEvents.organizationId, orgId));
    await systemDb.delete(invoiceDeliveries).where(eq(invoiceDeliveries.organizationId, orgId));
    await systemDb.delete(invoicePayments).where(eq(invoicePayments.organizationId, orgId));
    await systemDb.delete(invoiceInstalments).where(eq(invoiceInstalments.organizationId, orgId));
    await systemDb.delete(invoiceLineItems).where(eq(invoiceLineItems.organizationId, orgId));
    await systemDb.delete(invoices).where(eq(invoices.organizationId, orgId));
    await systemDb
      .delete(invoiceNumberSequences)
      .where(eq(invoiceNumberSequences.organizationId, orgId));
    await systemDb.delete(feeAgreements).where(eq(feeAgreements.organizationId, orgId));
    await systemDb.delete(feeAgreementSettings).where(eq(feeAgreementSettings.organizationId, orgId));
    await systemDb.delete(consultations).where(eq(consultations.organizationId, orgId));
    await systemDb.delete(leads).where(eq(leads.organizationId, orgId));
    await systemDb.delete(notifications).where(eq(notifications.organizationId, orgId));
    await systemDb.delete(staff).where(eq(staff.organizationId, orgId));
    await systemDb.delete(member).where(eq(member.organizationId, orgId));
    await systemDb.delete(organizationRole).where(eq(organizationRole.organizationId, orgId));
    await systemDb.delete(organization).where(eq(organization.id, orgId));
    for (const id of [ownerUserId, attorneyUserId, paralegalUserId]) {
      await systemDb.delete(user).where(eq(user.id, id));
    }
    for (const id of createdTypes)
      await systemDb.delete(practiceAreaCaseTypes).where(eq(practiceAreaCaseTypes.id, id));
    for (const id of createdSubs)
      await systemDb.delete(practiceAreaSubcategories).where(eq(practiceAreaSubcategories.id, id));
    for (const id of createdAreas)
      await systemDb.delete(practiceAreas).where(eq(practiceAreas.id, id));
  }

  await report();
  await closeDb();
};

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
