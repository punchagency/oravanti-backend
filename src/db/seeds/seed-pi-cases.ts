import { randomUUID } from "crypto";
import { eq, ilike } from "drizzle-orm";
import { db } from "../client";
import { organization } from "../schema/auth-schema";
import { clients } from "../schema/clients";
import { cases } from "../schema/cases";
import { practiceAreas } from "../schema/practice-areas";
import { practiceAreaSubcategories } from "../schema/practice-area-subcategories";
import { practiceAreaCaseTypes } from "../schema/practice-area-case-types";
import { staff } from "../schema/staff";

function isoDateFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

const PI_CLIENTS = [
  { firstName: "Sofia", lastName: "Martinez", case: "Rear-end collision on I-35, soft tissue injuries", status: "active" as const },
  { firstName: "Daniel", lastName: "Kim", case: "Slip and fall at grocery store, fractured wrist", status: "active" as const },
  { firstName: "Priya", lastName: "Raman", case: "Motorcycle accident, left leg fracture", status: "active" as const },
  { firstName: "Mateo", lastName: "Rivera", case: "Workplace injury, back strain from lifting", status: "active" as const },
  { firstName: "Hana", lastName: "Nakamura", case: "Dog bite incident, facial scarring", status: "active" as const },
];

export async function seedPICases(organizationId?: string) {
  let org;
  if (organizationId) {
    const [found] = await db.select().from(organization).where(eq(organization.id, organizationId)).limit(1);
    if (!found) {
      console.error(`Organization ${organizationId} not found.`);
      return;
    }
    org = found;
  } else {
    const orgs = await db.select().from(organization).limit(1);
    if (!orgs.length) {
      console.error("No organizations found. Run seed-staff-teams or demo-data seed first.");
      return;
    }
    org = orgs[0];
  }

  const areaRows = await db
    .select()
    .from(practiceAreas)
    .where(ilike(practiceAreas.name, "Personal Injury%"))
    .limit(1);
  if (!areaRows.length) {
    console.error('Personal Injury practice area not found. Run seed-taxonomy first.');
    return;
  }
  const piArea = areaRows[0];
  console.log(`Practice area: ${piArea.name} (${piArea.id})`);

  const subcategoryRows = await db
    .select()
    .from(practiceAreaSubcategories)
    .where(eq(practiceAreaSubcategories.practiceAreaId, piArea.id))
    .limit(1);
  if (!subcategoryRows.length) {
    console.error('No subcategory found for Personal Injury. Run seed-taxonomy first.');
    return;
  }
  const subcategory = subcategoryRows[0];

  const caseTypeRows = await db
    .select()
    .from(practiceAreaCaseTypes)
    .where(eq(practiceAreaCaseTypes.subcategoryId, subcategory.id))
    .limit(1);
  if (!caseTypeRows.length) {
    console.error('No case type found for Personal Injury subcategory. Run seed-taxonomy first.');
    return;
  }
  const piCaseType = caseTypeRows[0];
  console.log(`Case type: ${piCaseType.name} (code: ${piCaseType.code})`);

  const staffRows = await db
    .select()
    .from(staff)
    .where(eq(staff.organizationId, org.id))
    .limit(5);
  if (!staffRows.length) {
    console.error('No staff found. Run seed-staff-teams first.');
    return;
  }

  console.log(`\nCreating ${PI_CLIENTS.length} PI demo cases...\n`);

  for (let i = 0; i < PI_CLIENTS.length; i++) {
    const c = PI_CLIENTS[i];
    const assignedStaff = staffRows[i % staffRows.length];

    const [client] = await db
      .insert(clients)
      .values({
        organizationId: org.id,
        entityType: "individual",
        displayName: `${c.firstName} ${c.lastName}`,
        status: "active",
      })
      .returning();

    const caseNumber = `2026-PI-DEMO-${String(i + 1).padStart(3, "0")}`;

    await db
      .insert(cases)
      .values({
        organizationId: org.id,
        caseNumber,
        clientId: client.id,
        practiceAreaId: piArea.id,
        caseTypeId: piCaseType.id,
        caseType: piCaseType.code,
        status: c.status,
        priority: i === 2 ? "high" : "medium",
        assignmentType: "internal_team",
        requiredCertifications: [],
        caseProgress: (i * 20) % 100,
        filingDate: isoDateFromNow(-60 + i * 15),
        estimatedCompletionDate: isoDateFromNow(90 + i * 30),
        description: c.case,
        notes: `Demo PI case #${i + 1} for workflow testing.`,
        assignedStaffId: assignedStaff.id,
        createdByStaffId: assignedStaff.id,
      })
      .returning();

    console.log(`  ${caseNumber} — ${client.displayName} — ${c.case}`);
  }

  console.log("\nPI demo cases seeded successfully!");
  console.log(`\nUse these case IDs in the frontend or browse with:\n  npx tsx src/cli.ts cases browse`);
}
