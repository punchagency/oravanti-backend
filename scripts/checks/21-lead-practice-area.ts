/**
 * A lead always has a practice area AND a case type, and the two agree.
 *
 * The column was nullable, `createLeadBodySchema` marked it optional, and the
 * Add Lead dialog sent `|| undefined` on a blank select — so a lead could reach
 * the consultation stage with no practice area and then strand there: the fee
 * invoice is never raised (`raiseConsultationInvoice` returns null and the
 * caller swallows it), the booking gate stays closed against a debt with no
 * invoice behind it, and the only escape is a manual `feeStatus` PATCH.
 *
 * Three layers now say so, and this asserts all three — because two of them
 * read as convenience rather than as constraints:
 *
 *   - the create schema requires it
 *   - the update schema refuses a literal null, and an ABSENT field leaves the
 *     existing value alone (that second half rests on `diffNamedRef`'s falsy
 *     short-circuit, which looks like change detection and is in fact the guard)
 *   - the column is NOT NULL, so nothing reaching the database can blank it
 *
 * Runs against the TEST database (npm run check 21-lead-practice-area) and
 * cleans up the org it creates.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { organization, user } from "../../src/db/schema/auth-schema";
import { leads } from "../../src/db/schema/leads";
import { practiceAreaCaseTypes } from "../../src/db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../src/db/schema/practice-area-subcategories";
import { practiceAreas } from "../../src/db/schema/practice-areas";
import { staff } from "../../src/db/schema/staff";
import { ensureCaseTypeIdBelongsToPracticeArea } from "../../src/modules/practice-areas/practice-areas.utils";
import * as v from "../../src/modules/leads/leads.validation";
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
  let foreignCaseTypeId: string;
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
    // to entries rather than owning them. Two of our own so the update
    // assertions have somewhere real to move between.
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

    // A case type under each, so the cross-field assertions have a genuinely
    // foreign one to offer. A case type reaches its practice area only through
    // a subcategory, which is exactly why the two lead columns can disagree.
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
          name: "Type A",
          caseNumberPrefix: "AAA",
          jurisdiction: "federal",
        },
        {
          subcategoryId: subs[1]!.id,
          code: `type-b-${suffix}`,
          name: "Type B",
          caseNumberPrefix: "BBB",
          jurisdiction: "federal",
        },
      ])
      .returning();
    caseTypeId = types[0]!.id;
    foreignCaseTypeId = types[1]!.id;
    createdTypes.push(...types.map((x) => x.id));

    // ── 1. Creating ──────────────────────────────────────────────────────────
    section("A lead cannot be created without both classifiers");

    const body = {
      firstName: "Check",
      lastName: `Lead ${suffix}`,
      email: `lead-${suffix}@example.test`,
      source: "direct" as const,
    };

    // Each id asserted on its own, with the other supplied — otherwise a single
    // "both missing" case would pass for the wrong reason the moment one of the
    // two rules was removed.
    const noArea = v.createLeadBodySchema.safeParse({ ...body, caseTypeId });
    check("no practiceAreaId -> refused", !noArea.success);
    checkEqual(
      "and the error names the field",
      noArea.success ? null : (noArea.error.issues[0]?.path.join(".") ?? null),
      "practiceAreaId",
    );

    const noType = v.createLeadBodySchema.safeParse({
      ...body,
      practiceAreaId: areaId,
    });
    check("no caseTypeId -> refused", !noType.success);
    checkEqual(
      "and the error names that field",
      noType.success ? null : (noType.error.issues[0]?.path.join(".") ?? null),
      "caseTypeId",
    );

    check(
      "an empty string is not a practice area either",
      !v.createLeadBodySchema.safeParse({ ...body, practiceAreaId: "", caseTypeId })
        .success,
    );
    check(
      "nor is null",
      !v.createLeadBodySchema.safeParse({
        ...body,
        practiceAreaId: null,
        caseTypeId,
      }).success,
    );
    check(
      "an empty string is not a case type either",
      !v.createLeadBodySchema.safeParse({
        ...body,
        practiceAreaId: areaId,
        caseTypeId: "",
      }).success,
    );
    check(
      "a complete pair of uuids is accepted",
      v.createLeadBodySchema.safeParse({ ...body, practiceAreaId: areaId, caseTypeId })
        .success,
    );

    // ── 2. Updating ──────────────────────────────────────────────────────────
    section("Neither classifier can be cleared once set");

    check(
      "PATCH with a null practice area -> refused",
      !v.updateLeadBodySchema.safeParse({ practiceAreaId: null }).success,
    );
    check(
      "PATCH with a null case type -> refused",
      !v.updateLeadBodySchema.safeParse({ caseTypeId: null }).success,
    );
    check(
      "PATCH omitting it -> accepted (absent means unchanged)",
      v.updateLeadBodySchema.safeParse({ firstName: "Renamed" }).success,
    );
    check(
      "PATCH moving it to another area -> accepted",
      v.updateLeadBodySchema.safeParse({ practiceAreaId: otherAreaId }).success,
    );

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

    // The regression guard for `diffNamedRef`'s falsy short-circuit: it reads as
    // change detection, and it is also the only thing between an absent field
    // and a write. Revert `if (!args.nextId) return null` and this goes red.
    const { createLead, updateLead } = await import(
      "../../src/modules/leads/leads.service"
    );
    await updateLead(leadId, orgId, { firstName: "Renamed" }, staffId);

    const [afterOmit] = await systemDb
      .select({ practiceAreaId: leads.practiceAreaId })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    checkEqual(
      "an unrelated edit leaves the practice area alone",
      afterOmit!.practiceAreaId,
      areaId,
    );

    // ── 3. The two must describe the same practice area ──────────────────────
    section("A case type from another practice area is refused");

    // Neither foreign key can object: a case type reaches its practice area
    // only through its subcategory, so both columns are individually valid
    // while describing different areas. This is the only thing that notices.
    let crossRefused = false;
    try {
      await ensureCaseTypeIdBelongsToPracticeArea(areaId, foreignCaseTypeId);
    } catch {
      crossRefused = true;
    }
    check("a foreign case type is rejected", crossRefused);

    let matchedOk = true;
    try {
      await ensureCaseTypeIdBelongsToPracticeArea(areaId, caseTypeId);
    } catch {
      matchedOk = false;
    }
    check("a matching pair is accepted", matchedOk);

    let createRefused = false;
    try {
      await withOrgContext(orgId, userId, () =>
        createLead(
          orgId,
          {
            firstName: "Cross",
            lastName: `Check ${suffix}`,
            email: `cross-${suffix}@example.test`,
            source: "direct",
            practiceAreaId: areaId,
            caseTypeId: foreignCaseTypeId,
          },
          staffId,
        ),
      );
    } catch {
      createRefused = true;
    }
    check("createLead refuses a mismatched pair", createRefused);

    // The dangerous shape: nothing in the request even mentions the case type,
    // and moving the practice area alone would strand it under the old one.
    let orphanRefused = false;
    try {
      await withOrgContext(orgId, userId, () =>
        updateLead(leadId, orgId, { practiceAreaId: otherAreaId }, staffId),
      );
    } catch {
      orphanRefused = true;
    }
    check(
      "moving the practice area alone, orphaning the case type, is refused",
      orphanRefused,
    );

    const [stillA] = await systemDb
      .select({
        practiceAreaId: leads.practiceAreaId,
        caseTypeId: leads.caseTypeId,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    checkEqual("and nothing moved", stillA!.practiceAreaId, areaId);
    checkEqual("case type intact", stillA!.caseTypeId, caseTypeId);

    // Moving both together is the supported way to relocate a lead.
    let pairMoveOk = true;
    try {
      await withOrgContext(orgId, userId, () =>
        updateLead(
          leadId,
          orgId,
          { practiceAreaId: otherAreaId, caseTypeId: foreignCaseTypeId },
          staffId,
        ),
      );
    } catch {
      pairMoveOk = false;
    }
    check("moving both together is accepted", pairMoveOk);

    const [movedRow] = await systemDb
      .select({
        practiceAreaId: leads.practiceAreaId,
        caseTypeId: leads.caseTypeId,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    checkEqual("the pair moved together", movedRow!.practiceAreaId, otherAreaId);
    checkEqual("both sides agree", movedRow!.caseTypeId, foreignCaseTypeId);

    // Put it back so the null assertions below act on a known row.
    await systemDb
      .update(leads)
      .set({ practiceAreaId: areaId, caseTypeId })
      .where(eq(leads.id, leadId));

    // ── 4. The column itself ─────────────────────────────────────────────────
    section("The database refuses a null regardless of who asks");

    let refused = false;
    try {
      await systemDb
        .update(leads)
        // Cast: the schema type now forbids this, which is the point — the
        // assertion is that the DATABASE refuses it too, for anything that
        // reaches it by another route (a raw query, a future migration, a
        // caller that type-asserts its way past the compiler).
        .set({ practiceAreaId: null as unknown as string })
        .where(eq(leads.id, leadId));
    } catch {
      refused = true;
    }
    check("UPDATE ... SET practice_area_id = NULL is rejected", refused);

    let insertRefused = false;
    try {
      await systemDb.insert(leads).values({
        organizationId: orgId,
        firstName: "Check",
        lastName: `Nulled ${suffix}`,
        email: `nulled-${suffix}@example.test`,
        source: "direct",
        practiceAreaId: null as unknown as string,
        caseTypeId,
      });
    } catch {
      insertRefused = true;
    }
    check("INSERT with no practice area is rejected", insertRefused);
  } finally {
    if (leadId) await systemDb.delete(leads).where(eq(leads.organizationId, orgId));
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
