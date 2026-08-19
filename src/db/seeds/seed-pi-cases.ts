import { isCancel, note, select } from "@clack/prompts";
import { and, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../client";
import { organization, team } from "../schema/auth-schema";
import {
  caseBillingTypeEnum,
  casePriorityEnum,
  cases,
  caseStatusEnum,
} from "../schema/cases";
import { clients } from "../schema/clients";
import { practiceAreaCaseTypes } from "../schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../schema/practice-area-subcategories";
import { practiceAreas } from "../schema/practice-areas";
import { staff } from "../schema/staff";

type CaseStatus = (typeof caseStatusEnum.enumValues)[number];
type CasePriority = (typeof casePriorityEnum.enumValues)[number];
type CaseBillingType = (typeof caseBillingTypeEnum.enumValues)[number];

function isoDateFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

interface PIClient {
  firstName: string;
  lastName: string;
  subcategory: string; // matched to practiceAreaSubcategories.name
  caseType: string; // matched to practiceAreaCaseTypes.name
  description: string;
  jurisdiction: string;
  courtName?: string;
  judge?: string;
  docketNumber?: string;
  billingType: CaseBillingType;
  status: CaseStatus;
  priority: CasePriority;
  daysSinceFiling: number;
  daysToCompletion: number;
}

const PI_CLIENTS: PIClient[] = [
  // ── Motor Vehicle Accidents (7) ──────────────────────────────────────────
  {
    firstName: "Sofia",
    lastName: "Martinez",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Auto / Car Accident — Liability Claim",
    description:
      "Rear-end collision on I-95. Client sustained whiplash and herniated C5-C6 disc. Medical expenses $47,000. Liability admitted by opposing insurer.",
    jurisdiction: "state",
    courtName: "Miami-Dade County Court",
    judge: "Hon. Carlos A. Rodriguez",
    docketNumber: "2026-CA-004782",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -45,
    daysToCompletion: 180,
  },
  {
    firstName: "Daniel",
    lastName: "Kim",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Truck / Semi-Truck / Commercial Vehicle Collision",
    description:
      "Client's sedan struck by semi-truck on I-75. Multiple fractures including pelvis and femur. Lost 8 weeks of work as contractor. Federal FMCSA violations suspected.",
    jurisdiction: "federal & state",
    courtName: "US District Court, Middle District of Florida",
    judge: "Hon. Mary S. Lewis",
    docketNumber: "2026-CV-01123",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -30,
    daysToCompletion: 240,
  },
  {
    firstName: "Javier",
    lastName: "Morales",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Motorcycle Accident",
    description:
      "Client struck by left-turning vehicle at intersection. Compound fracture of right tibia and road rash requiring skin grafts. Lane-splitting dispute.",
    jurisdiction: "state",
    courtName: "Orange County Circuit Court",
    judge: "Hon. Patricia L. Strowbridge",
    docketNumber: "2026-CA-003891",
    billingType: "contingency",
    status: "active",
    priority: "medium",
    daysSinceFiling: -60,
    daysToCompletion: 210,
  },
  {
    firstName: "Aisha",
    lastName: "Johnson",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Uninsured Motorist (UM) Claim",
    description:
      "Client hit by uninsured driver who fled scene. UM/UIM coverage claim against own insurer. Policy limits $100k/$300k. Claimant has $65k in medicals.",
    jurisdiction: "state",
    courtName: "Broward County Court",
    judge: "Hon. Kenneth A. Gottlieb",
    docketNumber: "2026-CA-005210",
    billingType: "contingency",
    status: "pre_litigation",
    priority: "medium",
    daysSinceFiling: -15,
    daysToCompletion: 120,
  },
  {
    firstName: "Wei",
    lastName: "Chen",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Hit & Run Accident",
    description:
      "Pedestrian struck in crosswalk by hit-and-run driver. Broken hip and concussion. No witnesses. Crime Stoppers tip pending.",
    jurisdiction: "state",
    courtName: "Hillsborough County Circuit Court",
    judge: "Hon. Richard A. Nielsen",
    docketNumber: "2026-CA-001247",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -20,
    daysToCompletion: 150,
  },
  {
    firstName: "Maria",
    lastName: "Garcia",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Rideshare Accident (Uber / Lyft)",
    description:
      "Passenger injured when rideshare driver ran red light. Policy limits dispute between driver's personal policy and rideshare carrier's contingent coverage.",
    jurisdiction: "state",
    courtName: "Palm Beach County Court",
    judge: "Hon. Laura S. Johnson",
    docketNumber: "2026-CA-006543",
    billingType: "contingency",
    status: "active",
    priority: "medium",
    daysSinceFiling: -35,
    daysToCompletion: 160,
  },
  {
    firstName: "Omar",
    lastName: "Hassan",
    subcategory: "Motor Vehicle Accidents",
    caseType: "Distracted / Drowsy / Impaired Driver Claim",
    description:
      "Client T-boned by driver who ran red light while using mobile phone. Dashcam footage obtained. Fractured wrist and chronic back pain. Cell phone records subpoenaed.",
    jurisdiction: "state",
    courtName: "Duval County Circuit Court",
    judge: "Hon. James H. Daniel",
    docketNumber: "2026-CA-003782",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -50,
    daysToCompletion: 190,
  },
  // ── Premises Liability (3) ────────────────────────────────────────────────
  {
    firstName: "Priya",
    lastName: "Raman",
    subcategory: "Premises Liability",
    caseType: "Slip & Fall",
    description:
      "Client slipped on unmarked wet floor at big-box retail store. Torn meniscus requiring arthroscopic surgery. Store had no wet-floor signage. Prior incidents on file.",
    jurisdiction: "state",
    courtName: "Miami-Dade County Court",
    judge: "Hon. Jennifer D. Bailey",
    docketNumber: "2026-CA-002194",
    billingType: "contingency",
    status: "active",
    priority: "medium",
    daysSinceFiling: -40,
    daysToCompletion: 170,
  },
  {
    firstName: "Tyrone",
    lastName: "Williams",
    subcategory: "Premises Liability",
    caseType: "Negligent Security (Assault on Property)",
    description:
      "Client assaulted in apartment building parking lot with broken security cameras and non-functional gate. Multiple prior incidents reported to management.",
    jurisdiction: "state",
    courtName: "Broward County Circuit Court",
    judge: "Hon. Michael A. Hanzman",
    docketNumber: "2026-CA-004911",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -25,
    daysToCompletion: 200,
  },
  {
    firstName: "Lily",
    lastName: "Nguyen",
    subcategory: "Premises Liability",
    caseType: "Dog Bite & Animal Attack (FL §767.04)",
    description:
      "Client bitten by neighbor's rottweiler while walking in common area of apartment complex. Facial lacerations requiring plastic surgery. Animal control history obtained.",
    jurisdiction: "state",
    courtName: "Orange County Court",
    judge: "Hon. Heather P. Rodriguez",
    docketNumber: "2026-CA-001889",
    billingType: "contingency",
    status: "active",
    priority: "medium",
    daysSinceFiling: -55,
    daysToCompletion: 130,
  },
  // ── Medical Malpractice (2) ───────────────────────────────────────────────
  {
    firstName: "Robert",
    lastName: "Okafor",
    subcategory: "Medical Malpractice",
    caseType: "Misdiagnosis / Failure to Diagnose",
    description:
      "ER physician failed to order CT scan for patient presenting with stroke symptoms. Patient suffered permanent left-side weakness. Delay of 6 hours before correct diagnosis.",
    jurisdiction: "state",
    courtName: "Miami-Dade Circuit Court",
    judge: "Hon. Antonio Arzola",
    docketNumber: "2026-CA-007234",
    billingType: "contingency",
    status: "pre_litigation",
    priority: "urgent",
    daysSinceFiling: -10,
    daysToCompletion: 300,
  },
  {
    firstName: "Elena",
    lastName: "Vasquez",
    subcategory: "Medical Malpractice",
    caseType: "Surgical Errors",
    description:
      "Wrong-site surgery on left knee instead of right knee. Additional corrective surgery required. Permanent nerve damage. Hospital admitted error in internal report.",
    jurisdiction: "state",
    courtName: "Palm Beach Circuit Court",
    judge: "Hon. Meenu Sasser",
    docketNumber: "2026-CA-005677",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -28,
    daysToCompletion: 250,
  },
  // ── Product Liability (2) ─────────────────────────────────────────────────
  {
    firstName: "James",
    lastName: "Thompson",
    subcategory: "Product Liability",
    caseType: "Defective Product Design",
    description:
      "Client suffered third-degree burns when e-bike battery exploded during charging. Product had no UL certification. Multiple similar incidents reported to CPSC.",
    jurisdiction: "federal & state",
    courtName: "US District Court, Southern District of Florida",
    judge: "Hon. K. Michael Moore",
    docketNumber: "2026-CV-00891",
    billingType: "contingency",
    status: "pre_filing",
    priority: "high",
    daysSinceFiling: -5,
    daysToCompletion: 365,
  },
  {
    firstName: "Sarah",
    lastName: "Michaels",
    subcategory: "Product Liability",
    caseType: "Pharmaceutical / Drug Liability",
    description:
      "Client developed severe adverse reaction to prescription medication. Manufacturer failed to warn of known cardiac risks. FDA adverse event reports on file.",
    jurisdiction: "federal & state",
    courtName: "US District Court, Northern District of Florida",
    judge: "Hon. Mark E. Walker",
    docketNumber: "2026-CV-00745",
    billingType: "contingency",
    status: "pre_litigation",
    priority: "medium",
    daysSinceFiling: -12,
    daysToCompletion: 400,
  },
  // ── Wrongful Death (2) ────────────────────────────────────────────────────
  {
    firstName: "Carol",
    lastName: "Bennett",
    subcategory: "Wrongful Death",
    caseType: "Wrongful Death Claim — Surviving Spouse / Children",
    description:
      "Decedent killed in head-on collision with drunk driver. Survived by spouse and two minor children. Funeral expenses $15k. Lost future earnings estimated at $1.2M.",
    jurisdiction: "state",
    courtName: "Miami-Dade Circuit Court",
    judge: "Hon. Reemberto Diaz",
    docketNumber: "2026-CA-008902",
    billingType: "contingency",
    status: "active",
    priority: "critical",
    daysSinceFiling: -18,
    daysToCompletion: 180,
  },
  {
    firstName: "David",
    lastName: "Park",
    subcategory: "Wrongful Death",
    caseType: "Wrongful Death — Medical Malpractice",
    description:
      "Decedent died from undiagnosed sepsis after hospital discharge. ED physicians failed to follow sepsis protocol. Expert review confirms negligence.",
    jurisdiction: "state",
    courtName: "Broward Circuit Court",
    judge: "Hon. Marina Garcia-Wood",
    docketNumber: "2026-CA-006118",
    billingType: "contingency",
    status: "pre_litigation",
    priority: "high",
    daysSinceFiling: -8,
    daysToCompletion: 300,
  },
  // ── Workers' Compensation (2) ─────────────────────────────────────────────
  {
    firstName: "Carlos",
    lastName: "Mendez",
    subcategory: "Workers' Compensation",
    caseType: "On-the-Job Injury Claim Filing",
    description:
      "Construction worker fell from 12-foot ladder at residential job site. Fractured calcaneus and L3 compression fracture. Employer disputes compensability.",
    jurisdiction: "state",
    courtName: "Florida OJCC - Miami",
    judge: "Hon. David A. Thompson",
    docketNumber: "2026-WC-00345",
    billingType: "flat_fee",
    status: "active",
    priority: "high",
    daysSinceFiling: -22,
    daysToCompletion: 120,
  },
  {
    firstName: "Grace",
    lastName: "O'Brien",
    subcategory: "Workers' Compensation",
    caseType: "Repetitive Motion / Cumulative Trauma",
    description:
      "Warehouse worker developed bilateral carpal tunnel syndrome after 5 years of repetitive lifting. Employer denied claim as non-occupational. EMG/NCV studies confirm severity.",
    jurisdiction: "state",
    courtName: "Florida OJCC - Orlando",
    judge: "Hon. Ellen H. Weisbrot",
    docketNumber: "2026-WC-00298",
    billingType: "contingency",
    status: "active",
    priority: "medium",
    daysSinceFiling: -42,
    daysToCompletion: 90,
  },
  // ── Insurance Claims & Bad Faith (2) ──────────────────────────────────────
  {
    firstName: "Michael",
    lastName: "Foster",
    subcategory: "Insurance Claims & Bad Faith",
    caseType: "First-Party Insurance Bad Faith",
    description:
      "Insurer unreasonably delayed approval of medically necessary surgery for 14 months despite multiple peer-to-peer reviews. Claimant now has permanent nerve damage.",
    jurisdiction: "state",
    courtName: "Miami-Dade Circuit Court",
    judge: "Hon. William Thomas",
    docketNumber: "2026-CA-009455",
    billingType: "contingency",
    status: "active",
    priority: "high",
    daysSinceFiling: -38,
    daysToCompletion: 160,
  },
  {
    firstName: "Nina",
    lastName: "Patel",
    subcategory: "Insurance Claims & Bad Faith",
    caseType: "Homeowner's Insurance Claim Disputes",
    description:
      "Insurer denied hurricane damage claim citing pre-existing condition despite adjuster report showing wind-driven roof damage. Expert engineer confirms storm causation.",
    jurisdiction: "state",
    courtName: "Palm Beach Circuit Court",
    judge: "Hon. Glenn D. Kelley",
    docketNumber: "2026-CA-007321",
    billingType: "contingency",
    status: "pre_litigation",
    priority: "medium",
    daysSinceFiling: -14,
    daysToCompletion: 140,
  },
];

export async function seedPICases(organizationId?: string) {
  let org;
  if (organizationId) {
    const [found] = await db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!found) {
      console.error(`Organization ${organizationId} not found.`);
      return;
    }
    org = found;
  } else {
    const orgs = await db.select().from(organization).limit(1);
    if (!orgs.length) {
      console.error(
        "No organizations found. Run seed-staff-teams or demo-data seed first.",
      );
      return;
    }
    org = orgs[0];
  }

  const [piArea] = await db
    .select()
    .from(practiceAreas)
    .where(ilike(practiceAreas.name, "Personal Injury%"))
    .limit(1);
  if (!piArea) {
    console.error(
      "Personal Injury practice area not found. Run seed-taxonomy first.",
    );
    return;
  }

  // Resolve all subcategories under PI
  const subcategoryRows = await db
    .select()
    .from(practiceAreaSubcategories)
    .where(eq(practiceAreaSubcategories.practiceAreaId, piArea.id));
  if (!subcategoryRows.length) {
    console.error(
      "No subcategories found for Personal Injury. Run seed-taxonomy first.",
    );
    return;
  }
  const subcategoryByName = Object.fromEntries(
    subcategoryRows.map((s) => [s.name, s]),
  );

  // Resolve all case types for those subcategories
  const subcategoryIds = subcategoryRows.map((s) => s.id);
  const allCaseTypes = await db
    .select()
    .from(practiceAreaCaseTypes)
    .where(inArray(practiceAreaCaseTypes.subcategoryId, subcategoryIds));
  const caseTypeByName: Record<
    string,
    typeof practiceAreaCaseTypes.$inferSelect
  > = {};
  for (const t of allCaseTypes) caseTypeByName[t.name] = t;

  // Resolve staff and team
  const staffRows = await db
    .select()
    .from(staff)
    .where(eq(staff.organizationId, org.id))
    .limit(5);
  if (!staffRows.length) {
    console.error("No staff found. Run seed-staff-teams first.");
    return;
  }

  const teamRows = await db
    .select()
    .from(team)
    .where(eq(team.organizationId, org.id));
  if (!teamRows.length) {
    console.error("No teams found. Run seed-staff-teams first.");
    return;
  }

  let selectedTeam = teamRows[0];
  if (teamRows.length > 1) {
    const teamId = await select({
      message: "Select a team to assign cases to",
      options: teamRows.map((t) => ({
        value: t.id,
        label: t.name,
        hint: t.status ?? undefined,
      })),
    });
    if (isCancel(teamId)) {
      console.log("Cancelled.");
      return;
    }
    selectedTeam = teamRows.find((t) => t.id === teamId) ?? teamRows[0];
  } else {
    note(`Using team: ${selectedTeam.name}`, "Auto-selected");
  }

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < PI_CLIENTS.length; i++) {
    const c = PI_CLIENTS[i];
    const subcategory = subcategoryByName[c.subcategory];
    if (!subcategory) {
      console.error(`  SKIP — subcategory "${c.subcategory}" not found`);
      skipped++;
      continue;
    }

    const caseType = caseTypeByName[c.caseType];
    if (!caseType) {
      console.error(`  SKIP — case type "${c.caseType}" not found`);
      skipped++;
      continue;
    }

    const assignedStaff = staffRows[i % staffRows.length];

    const year = new Date().getFullYear();
    const prefix = `${year}-${caseType.caseNumberPrefix}-`;
    let seq = 1;
    let caseNumber: string;
     
    while (true) {
      caseNumber = `${prefix}${String(seq).padStart(3, "0")}`;
      const [exists] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.caseNumber, caseNumber))
        .limit(1);
      if (!exists) break;
      seq++;
    }

    const existingClient = (
      await db
        .select({ id: clients.id, displayName: clients.displayName })
        .from(clients)
        .where(
          and(
            eq(clients.organizationId, org.id),
            eq(clients.firstName, c.firstName),
            eq(clients.lastName, c.lastName),
          ),
        )
        .limit(1)
    )[0];

    const client =
      existingClient ??
      (
        await db
          .insert(clients)
          .values({
            organizationId: org.id,
            entityType: "individual",
            firstName: c.firstName,
            lastName: c.lastName,
            displayName: `${c.firstName} ${c.lastName}`,
            email: `${c.firstName.toLowerCase()}.${c.lastName.toLowerCase()}@example.com`,
            status: "active",
          })
          .returning()
      )[0];

    await db
      .insert(cases)
      .values({
        organizationId: org.id,
        caseNumber,
        clientId: client.id,
        practiceAreaId: piArea.id,
        caseTypeId: caseType.id,
        status: c.status,
        priority: c.priority,
        caseProgress: (i * 5) % 100,
        filingDate: isoDateFromNow(c.daysSinceFiling),
        estimatedCompletionDate: isoDateFromNow(c.daysToCompletion),
        description: c.description,
        assignedTeamId: selectedTeam.id,
        openedById: assignedStaff.id,
        billingType: c.billingType,
        jurisdiction: c.jurisdiction,
        courtName: c.courtName,
        assignedJudge: c.judge,
        courtDocketNumber: c.docketNumber,
        assignmentDate: new Date(),
      })
      .returning();

    console.log(`  ${caseNumber} — ${client.displayName} — ${caseType.name}`);
    created++;
  }

  console.log(`\nPI demo cases seeded: ${created} created, ${skipped} skipped`);
}
