/**
 * A fee agreement records what it is about, and keeps saying so afterwards.
 *
 * `generateFeeAgreement` wrote `practiceAreaId: undefined, caseTypeId: undefined`
 * from the day the columns existed, so every row was NULL on both. Nothing read
 * them — the document assembler and the invoice path each resolved through the
 * lead instead — so the gap was invisible until you re-classified a lead and
 * watched an already-signed agreement change what it said the matter was.
 *
 * An agreement is a legal document. What it covers is fixed when it is
 * generated, not looked up fresh each time it is rendered. Three things now say
 * so, and this asserts all three:
 *
 *   - generation snapshots both ids off the lead
 *   - the readers use the snapshot, so re-classifying the lead cannot move them
 *   - the columns are NOT NULL, so nothing reaching the database can blank them
 *
 * Regeneration is deliberately NOT frozen: `discardDraftFeeAgreement` hard-
 * deletes the draft, so a re-generated agreement re-snapshots from the lead as
 * it stands then. That is the intent, and it is asserted too — otherwise a
 * future "optimisation" that turned discard into an UPDATE would strand the old
 * classification on the new agreement with nothing to catch it.
 *
 * Runs against the TEST database (npm run check 23-fee-agreement-classification)
 * and cleans up the org it creates.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { organization, user } from "../../src/db/schema/auth-schema";
import { consultations } from "../../src/db/schema/consultations";
import { feeAgreements } from "../../src/db/schema/fee-agreements";
import { leads } from "../../src/db/schema/leads";
import { practiceAreaCaseTypes } from "../../src/db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../src/db/schema/practice-area-subcategories";
import { practiceAreas } from "../../src/db/schema/practice-areas";
import { staff } from "../../src/db/schema/staff";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
} from "./_bootstrap";

const main = async () => {
  const suffix = randomUUID().slice(0, 8);
  const orgId = `check-org-${suffix}`;
  const userId = `check-user-${suffix}`;
  const now = new Date();

  let leadId = "";
  let staffId = "";
  // Assigned from the catalogue rows seeded below; no meaningful initial value.
  let areaId: string;
  let otherAreaId: string;
  let caseTypeId: string;
  let otherCaseTypeId: string;
  const createdAreas: string[] = [];
  const createdSubs: string[] = [];
  const createdTypes: string[] = [];

  try {
    await systemDb.insert(user).values({
      id: userId,
      name: `Check User ${suffix}`,
      email: `check-${suffix}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await systemDb.insert(organization).values({
      id: orgId,
      name: `Check Org ${suffix}`,
      slug: `check-org-${suffix}`,
      createdAt: now,
    });
    const [staffRow] = await systemDb
      .insert(staff)
      .values({
        organizationId: orgId,
        userId,
        firstName: "Check",
        lastName: `Staff ${suffix}`,
        email: `staff-${suffix}@example.test`,
        role: "admin",
      })
      .returning();
    staffId = staffRow!.id;

    // `practice_areas` is a GLOBAL catalogue, not org-scoped — firms subscribe
    // to entries rather than owning them. Two of our own so the re-classify
    // assertions have somewhere real to move the lead to.
    const areas = await systemDb
      .insert(practiceAreas)
      .values([
        { name: `Check Area A ${suffix}` },
        { name: `Check Area B ${suffix}` },
      ])
      .returning();
    areaId = areas[0]!.id;
    otherAreaId = areas[1]!.id;
    createdAreas.push(...areas.map((a) => a.id));

    const subs = await systemDb
      .insert(practiceAreaSubcategories)
      .values([
        { practiceAreaId: areaId, code: `sub-a-${suffix}`, name: "Sub A" },
        { practiceAreaId: otherAreaId, code: `sub-b-${suffix}`, name: "Sub B" },
      ])
      .returning();
    createdSubs.push(...subs.map((x) => x.id));

    const types = await systemDb
      .insert(practiceAreaCaseTypes)
      .values([
        {
          subcategoryId: subs[0]!.id,
          code: `type-a-${suffix}`,
          name: `Original Matter ${suffix}`,
          caseNumberPrefix: "AAA",
          jurisdiction: "federal",
        },
        {
          subcategoryId: subs[1]!.id,
          code: `type-b-${suffix}`,
          name: `Reclassified Matter ${suffix}`,
          caseNumberPrefix: "BBB",
          jurisdiction: "federal",
        },
      ])
      .returning();
    caseTypeId = types[0]!.id;
    otherCaseTypeId = types[1]!.id;
    createdTypes.push(...types.map((x) => x.id));

    const [leadRow] = await systemDb
      .insert(leads)
      .values({
        organizationId: orgId,
        firstName: "Check",
        lastName: `Lead ${suffix}`,
        email: `lead-${suffix}@example.test`,
        source: "direct",
        practiceAreaId: areaId,
        caseTypeId,
      })
      .returning();
    leadId = leadRow!.id;

    // Generation is gated on a completed consultation.
    await systemDb.insert(consultations).values({
      organizationId: orgId,
      leadId,
      duration: 60,
      mode: "video",
      status: "completed",
    });

    // Both are class members rather than module exports, so go through the
    // service the controller uses.
    const { LeadsService } = await import(
      "../../src/modules/leads/leads.service"
    );
    const svc = new LeadsService();

    const attorneyFee = { type: "flat" as const, amount: 1500 };

    // ── 1. Generation snapshots the lead ────────────────────────────────────
    section("A generated agreement records the lead's classification");

    const generated = await withOrgContext(orgId, userId, () =>
      svc.generateFeeAgreement(
        leadId,
        orgId,
        { attorneyFee, generatedFrom: "manual" },
        staffId,
      ),
    );
    const agreementId = generated.agreement.id;

    checkEqual(
      "the agreement carries the lead's practice area",
      generated.agreement.practiceAreaId,
      areaId,
    );
    checkEqual(
      "and the lead's case type",
      generated.agreement.caseTypeId,
      caseTypeId,
    );
    checkEqual(
      "the rendered document names the matter",
      generated.document.client.matterType,
      `Original Matter ${suffix}`,
    );

    // ── 2. Re-classifying the lead must not move it ─────────────────────────
    section("Re-classifying the lead leaves a generated agreement alone");

    // Straight to the column: the point is that the AGREEMENT is unmoved, not
    // that a particular service path refuses the edit.
    await systemDb
      .update(leads)
      .set({ practiceAreaId: otherAreaId, caseTypeId: otherCaseTypeId })
      .where(eq(leads.id, leadId));

    const [afterReclassify] = await systemDb
      .select({
        practiceAreaId: feeAgreements.practiceAreaId,
        caseTypeId: feeAgreements.caseTypeId,
      })
      .from(feeAgreements)
      .where(eq(feeAgreements.id, agreementId))
      .limit(1);

    checkEqual(
      "the agreement's practice area is unchanged",
      afterReclassify!.practiceAreaId,
      areaId,
    );
    checkEqual(
      "its case type is unchanged",
      afterReclassify!.caseTypeId,
      caseTypeId,
    );

    // The reader is the half that actually reaches a user. Point
    // `assembleFeeAgreementDocument` back at `leads.caseTypeId` and this is the
    // assertion that goes red.
    const { assembleFeeAgreementDocument } = await import(
      "../../src/modules/leads/fee-agreement-document"
    );
    const [storedAgreement] = await systemDb
      .select()
      .from(feeAgreements)
      .where(eq(feeAgreements.id, agreementId))
      .limit(1);

    const rerendered = await withOrgContext(orgId, userId, () =>
      assembleFeeAgreementDocument(storedAgreement!, orgId),
    );
    checkEqual(
      "and the re-rendered document still names the original matter",
      rerendered.client.matterType,
      `Original Matter ${suffix}`,
    );

    // ── 3. Regeneration re-snapshots ────────────────────────────────────────
    section("Discarding and regenerating picks up the lead's current values");

    await withOrgContext(orgId, userId, () =>
      svc.discardDraftFeeAgreement(agreementId, orgId),
    );

    const regenerated = await withOrgContext(orgId, userId, () =>
      svc.generateFeeAgreement(
        leadId,
        orgId,
        { attorneyFee, generatedFrom: "manual" },
        staffId,
      ),
    );

    checkEqual(
      "the new agreement takes the lead's new practice area",
      regenerated.agreement.practiceAreaId,
      otherAreaId,
    );
    checkEqual(
      "and its new case type",
      regenerated.agreement.caseTypeId,
      otherCaseTypeId,
    );
    checkEqual(
      "and its document names the new matter",
      regenerated.document.client.matterType,
      `Reclassified Matter ${suffix}`,
    );

    // ── 4. The columns themselves ───────────────────────────────────────────
    section("The database refuses a null regardless of who asks");

    let updateRefused = false;
    try {
      await systemDb
        .update(feeAgreements)
        // Cast: the schema type now forbids this, which is the point — the
        // assertion is that the DATABASE refuses it too, for anything reaching
        // it by another route (a raw query, a future migration, a caller that
        // type-asserts its way past the compiler).
        .set({ practiceAreaId: null as unknown as string })
        .where(eq(feeAgreements.id, regenerated.agreement.id));
    } catch {
      updateRefused = true;
    }
    check("UPDATE ... SET practice_area_id = NULL is rejected", updateRefused);

    let caseTypeNullRefused = false;
    try {
      await systemDb
        .update(feeAgreements)
        .set({ caseTypeId: null as unknown as string })
        .where(eq(feeAgreements.id, regenerated.agreement.id));
    } catch {
      caseTypeNullRefused = true;
    }
    check(
      "UPDATE ... SET case_type_id = NULL is rejected",
      caseTypeNullRefused,
    );

    let insertRefused = false;
    try {
      await systemDb.insert(feeAgreements).values({
        organizationId: orgId,
        leadId,
        practiceAreaId: null as unknown as string,
        caseTypeId,
        status: "draft",
      });
    } catch {
      insertRefused = true;
    }
    check("INSERT with no practice area is rejected", insertRefused);
  } finally {
    if (leadId) {
      await systemDb
        .delete(feeAgreements)
        .where(eq(feeAgreements.organizationId, orgId));
      await systemDb
        .delete(consultations)
        .where(eq(consultations.organizationId, orgId));
      // The lead points at its agreement, so it must go after it.
      await systemDb.delete(leads).where(eq(leads.organizationId, orgId));
    }
    if (staffId) await systemDb.delete(staff).where(eq(staff.organizationId, orgId));
    await systemDb.delete(organization).where(eq(organization.id, orgId));
    await systemDb.delete(user).where(eq(user.id, userId));
    for (const id of createdTypes)
      await systemDb
        .delete(practiceAreaCaseTypes)
        .where(eq(practiceAreaCaseTypes.id, id));
    for (const id of createdSubs)
      await systemDb
        .delete(practiceAreaSubcategories)
        .where(eq(practiceAreaSubcategories.id, id));
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
