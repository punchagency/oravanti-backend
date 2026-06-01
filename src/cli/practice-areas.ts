import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { Command } from "commander";
import { randomUUID } from "crypto";
import { and, asc, eq, inArray, ilike } from "drizzle-orm";
import { closeDb, db } from "../db/client";
import { admins } from "../db/schema/admins";
import { aiErrorFlags } from "../db/schema/ai-error-flags";
import { aiSystemConfig } from "../db/schema/ai-system-config";
import { calendarEvents } from "../db/schema/calendar-events";
import { cases } from "../db/schema/cases";
import { clientRequests } from "../db/schema/client-requests";
import { clients } from "../db/schema/clients";
import { companies } from "../db/schema/companies";
import { documents } from "../db/schema/documents";
import { organization as organizations } from "../db/schema/auth-schema";
import { firmPracticeAreas } from "../db/schema/firm-practice-areas";
import { practiceAreaCaseTypes } from "../db/schema/practice-area-case-types";
import { practiceAreas } from "../db/schema/practice-areas";
import { staff } from "../db/schema/staff";
import { subscriptions, SubscriptionStatus } from "../db/schema/subscriptions";
import { tasks } from "../db/schema/tasks";
import { teamMembers } from "../db/schema/team-members";
import { teams } from "../db/schema/teams";
import { timeEntries } from "../db/schema/time-entries";

const DEFAULT_PRACTICE_AREAS = [
  "Immigration",
  "Family",
  "Business",
  "Estate",
  "Real Estate",
  "Personal Injury",
  "Criminal",
  "Employment",
] as const;

const DEFAULT_IMMIGRATION_CASE_TYPES = [
  { code: "h1b_visa", name: "H-1B Visa", caseNumberPrefix: "H1B" },
  { code: "green_card", name: "Green Card", caseNumberPrefix: "GC" },
  { code: "citizenship", name: "Citizenship", caseNumberPrefix: "CIT" },
  { code: "l1_visa", name: "L-1 Visa", caseNumberPrefix: "L1" },
  { code: "asylum", name: "Asylum", caseNumberPrefix: "ASY" },
  { code: "family_petition", name: "Family Petition", caseNumberPrefix: "FAM" },
  {
    code: "e2_treaty_investor",
    name: "E-2 Treaty Investor",
    caseNumberPrefix: "E2",
  },
  {
    code: "o1_extraordinary_ability",
    name: "O-1 Extraordinary Ability",
    caseNumberPrefix: "O1",
  },
  {
    code: "eb1_priority_workers",
    name: "EB-1 Priority Workers",
    caseNumberPrefix: "EB1",
  },
  {
    code: "eb2_advanced_degree",
    name: "EB-2 Advanced Degree",
    caseNumberPrefix: "EB2",
  },
  {
    code: "eb3_skilled_workers",
    name: "EB-3 Skilled Workers",
    caseNumberPrefix: "EB3",
  },
  {
    code: "eb5_immigrant_investor",
    name: "EB-5 Immigrant Investor",
    caseNumberPrefix: "EB5",
  },
  {
    code: "work_authorization",
    name: "Work Authorization",
    caseNumberPrefix: "EAD",
  },
  { code: "travel_document", name: "Travel Document", caseNumberPrefix: "TRV" },
  { code: "naturalization", name: "Naturalization", caseNumberPrefix: "NAT" },
  { code: "other", name: "Other", caseNumberPrefix: "OTH" },
] as const;

type PracticeAreaRow = typeof practiceAreas.$inferSelect;
type PracticeAreaCaseTypeRow = typeof practiceAreaCaseTypes.$inferSelect;
type FirmRow = {
  id: string;
  firmName: string;
  firmEmail: string | null;
  city: string | null;
  state: string | null;
};

type CaseTypeInput = {
  code: string;
  name: string;
  caseNumberPrefix: string;
};

type DemoSeedResult = {
  firm: Pick<FirmRow, "id" | "firmName">;
  practiceArea: { id: string; name: string };
  subscriptionId: string;
  adminId: string;
  staffCount: number;
  teamId: string;
  companyId: string;
  clientCount: number;
  caseCount: number;
  documentCount: number;
  taskCount: number;
  calendarEventCount: number;
  clientRequestCount: number;
  timeEntryCount: number;
  aiErrorFlagCount: number;
};

const program = new Command();

const abortIfCancelled = <T>(value: T | symbol): T => {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exitCode = 1;
    throw new Error("cancelled");
  }

  return value;
};

const normalizeName = (name: string) => name.trim();
const normalizeKey = (name: string) => normalizeName(name).toLocaleLowerCase();
const normalizeCode = (code: string) => code.trim().toLowerCase();
const normalizePrefix = (prefix: string) => prefix.trim().toUpperCase();
const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const isoDateFromNow = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const timestampFromNow = (days: number, hour = 14) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
};

const assertDevelopment = () => {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("Demo data seeding is only available in development.");
  }
};

const parseNames = (input: string | readonly string[]) => {
  const rawNames = typeof input === "string" ? input.split(/\r?\n|,/) : input;

  const names: string[] = [];
  const seen = new Set<string>();

  for (const rawName of rawNames) {
    const name = normalizeName(rawName);
    const key = normalizeKey(name);

    if (!name || seen.has(key)) continue;

    seen.add(key);
    names.push(name);
  }

  return names;
};

const getPracticeAreas = () =>
  db
    .select({
      id: practiceAreas.id,
      name: practiceAreas.name,
      createdAt: practiceAreas.createdAt,
      updatedAt: practiceAreas.updatedAt,
    })
    .from(practiceAreas)
    .orderBy(asc(practiceAreas.name));

const getFirms = () =>
  db
    .select({
      id: organizations.id,
      firmName: organizations.name,
      firmEmail: organizations.emailAddress,
      city: organizations.city,
      state: organizations.state,
    })
    .from(organizations)
    .orderBy(asc(organizations.name));

const getCaseTypes = (practiceAreaId: string) =>
  db
    .select()
    .from(practiceAreaCaseTypes)
    .where(eq(practiceAreaCaseTypes.practiceAreaId, practiceAreaId))
    .orderBy(asc(practiceAreaCaseTypes.name));

const printPracticeAreas = (areas: PracticeAreaRow[]) => {
  if (!areas.length) {
    note("No practice areas found.");
    return;
  }

  console.table(
    areas.map((area) => ({
      id: area.id,
      name: area.name,
      createdAt: area.createdAt.toISOString(),
      updatedAt: area.updatedAt.toISOString(),
    })),
  );
};

const printDemoSeedResult = (result: DemoSeedResult) => {
  console.table([
    {
      firm: result.firm.firmName,
      practiceArea: result.practiceArea.name,
      subscriptionId: result.subscriptionId,
      adminId: result.adminId,
      staff: result.staffCount,
      teamId: result.teamId,
      companyId: result.companyId,
      clients: result.clientCount,
      cases: result.caseCount,
      documents: result.documentCount,
      tasks: result.taskCount,
      calendarEvents: result.calendarEventCount,
      clientRequests: result.clientRequestCount,
      timeEntries: result.timeEntryCount,
      aiErrorFlags: result.aiErrorFlagCount,
    },
  ]);
};

const printCaseTypes = (caseTypes: PracticeAreaCaseTypeRow[]) => {
  if (!caseTypes.length) {
    note("No case types found.");
    return;
  }

  console.table(
    caseTypes.map((caseType) => ({
      id: caseType.id,
      practiceAreaId: caseType.practiceAreaId,
      code: caseType.code,
      name: caseType.name,
      caseNumberPrefix: caseType.caseNumberPrefix,
      createdAt: caseType.createdAt.toISOString(),
      updatedAt: caseType.updatedAt.toISOString(),
    })),
  );
};

const parseCaseTypeDefinitions = (
  input: string | readonly string[] | readonly CaseTypeInput[],
) => {
  const rawDefinitions =
    typeof input === "string"
      ? input.split(/\r?\n/)
      : input.map((item) =>
          typeof item === "string"
            ? item
            : `${item.code}|${item.name}|${item.caseNumberPrefix}`,
        );

  const definitions: CaseTypeInput[] = [];
  const seen = new Set<string>();

  for (const rawDefinition of rawDefinitions) {
    const parts = rawDefinition.split("|").map((part) => part.trim());
    const [rawCode, rawName, rawPrefix] = parts;
    const code = normalizeCode(rawCode ?? "");
    const name = normalizeName(rawName ?? "");
    const caseNumberPrefix = normalizePrefix(rawPrefix ?? "");

    if (!code || !name || !caseNumberPrefix || seen.has(code)) continue;

    seen.add(code);
    definitions.push({ code, name, caseNumberPrefix });
  }

  return definitions;
};

const promptForNames = async () => {
  const names = abortIfCancelled(
    await text({
      message: "Enter one or more practice area names",
      placeholder: "Immigration, Family, Business",
      validate(value) {
        return parseNames(value).length ? undefined : "Enter at least one name.";
      },
    }),
  );

  return parseNames(names);
};

const createPracticeAreas = async (names: readonly string[]) => {
  const cleanedNames = parseNames(names);

  if (!cleanedNames.length) {
    note("No valid practice area names were provided.");
    return;
  }

  const existingAreas = await getPracticeAreas();
  const existingNames = new Set(existingAreas.map((area) => normalizeKey(area.name)));
  const skipped = cleanedNames.filter((name) => existingNames.has(normalizeKey(name)));
  const namesToCreate = cleanedNames.filter(
    (name) => !existingNames.has(normalizeKey(name)),
  );

  if (!namesToCreate.length) {
    note(`All provided names already exist: ${skipped.join(", ")}`);
    return;
  }

  const created = await db
    .insert(practiceAreas)
    .values(namesToCreate.map((name) => ({ name })))
    .returning();

  printPracticeAreas(created);

  if (skipped.length) {
    note(`Skipped existing practice areas: ${skipped.join(", ")}`);
  }
};

const resolvePracticeArea = async (id?: string) => {
  const areas = await getPracticeAreas();

  if (!areas.length) {
    note("No practice areas found.");
    return null;
  }

  if (id) {
    const area = areas.find((currentArea) => currentArea.id === id);
    if (!area) {
      note(`Practice area not found: ${id}`);
      return null;
    }

    return area;
  }

  const selectedId = abortIfCancelled(
    await select({
      message: "Select a practice area",
      options: areas.map((area) => ({
        value: area.id,
        label: area.name,
        hint: area.id,
      })),
    }),
  );

  return areas.find((area) => area.id === selectedId) ?? null;
};

const resolveFirm = async (id?: string) => {
  const allFirms = await getFirms();

  if (!allFirms.length) {
    note("No firms found.");
    return null;
  }

  if (id) {
    const firm = allFirms.find((currentFirm) => currentFirm.id === id);
    if (!firm) {
      note(`Firm not found: ${id}`);
      return null;
    }

    return firm;
  }

  const selectedId = abortIfCancelled(
    await select({
      message: "Select a firm for demo data",
      options: allFirms.map((firm) => ({
        value: firm.id,
        label: firm.firmName,
        hint: firm.firmEmail ?? undefined,
      })),
    }),
  );

  return allFirms.find((firm) => firm.id === selectedId) ?? null;
};

const resolvePracticeAreaByName = async (name: string) => {
  const areas = await getPracticeAreas();
  return areas.find((area) => normalizeKey(area.name) === normalizeKey(name)) ?? null;
};

const promptForCaseTypeDefinitions = async () => {
  const definitions = abortIfCancelled(
    await text({
      message: "Enter case types as code|Name|PREFIX, one per line",
      placeholder: "h1b_visa|H-1B Visa|H1B",
      validate(value) {
        return parseCaseTypeDefinitions(value).length
          ? undefined
          : "Enter at least one case type definition.";
      },
    }),
  );

  return parseCaseTypeDefinitions(definitions);
};

const createCaseTypes = async (
  practiceAreaId: string | undefined,
  definitions: readonly string[] | readonly CaseTypeInput[],
) => {
  const area = await resolvePracticeArea(practiceAreaId);
  if (!area) return;

  const parsedDefinitions = parseCaseTypeDefinitions(definitions);
  if (!parsedDefinitions.length) {
    note("No valid case type definitions were provided.");
    return;
  }

  const existingCaseTypes = await getCaseTypes(area.id);
  const existingCodes = new Set(existingCaseTypes.map((caseType) => caseType.code));
  const skipped = parsedDefinitions.filter((item) => existingCodes.has(item.code));
  const definitionsToCreate = parsedDefinitions.filter(
    (item) => !existingCodes.has(item.code),
  );

  if (!definitionsToCreate.length) {
    note(`All provided case types already exist: ${skipped.map((item) => item.code).join(", ")}`);
    return;
  }

  const created = await db
    .insert(practiceAreaCaseTypes)
    .values(
      definitionsToCreate.map((item) => ({
        practiceAreaId: area.id,
        code: item.code,
        name: item.name,
        caseNumberPrefix: item.caseNumberPrefix,
      })),
    )
    .returning();

  printCaseTypes(created);

  if (skipped.length) {
    note(`Skipped existing case types: ${skipped.map((item) => item.code).join(", ")}`);
  }
};

const createDefaultImmigrationCaseTypes = async (practiceAreaId?: string) => {
  const area = practiceAreaId
    ? await resolvePracticeArea(practiceAreaId)
    : await resolvePracticeAreaByName("Immigration");

  if (!area) {
    note("Immigration practice area not found. Create it first or pass its id.");
    return;
  }

  await createCaseTypes(area.id, DEFAULT_IMMIGRATION_CASE_TYPES);
};

const resolveCaseType = async (practiceAreaId?: string, caseTypeId?: string) => {
  const area = await resolvePracticeArea(practiceAreaId);
  if (!area) return null;

  const caseTypes = await getCaseTypes(area.id);
  if (!caseTypes.length) {
    note(`No case types found for ${area.name}.`);
    return null;
  }

  if (caseTypeId) {
    const caseType = caseTypes.find((currentCaseType) => currentCaseType.id === caseTypeId);
    if (!caseType) {
      note(`Case type not found: ${caseTypeId}`);
      return null;
    }

    return { area, caseType };
  }

  const selectedId = abortIfCancelled(
    await select({
      message: "Select a case type",
      options: caseTypes.map((caseType) => ({
        value: caseType.id,
        label: caseType.name,
        hint: `${caseType.code} (${caseType.caseNumberPrefix})`,
      })),
    }),
  );

  const caseType = caseTypes.find((currentCaseType) => currentCaseType.id === selectedId);
  return caseType ? { area, caseType } : null;
};

const editCaseType = async (
  practiceAreaId?: string,
  caseTypeId?: string,
  options?: { code?: string; name?: string; prefix?: string },
) => {
  const resolved = await resolveCaseType(practiceAreaId, caseTypeId);
  if (!resolved) return;

  const nextCode = options?.code
    ? normalizeCode(options.code)
    : normalizeCode(
        abortIfCancelled(
          await text({
            message: `Code for "${resolved.caseType.name}"`,
            placeholder: resolved.caseType.code,
            defaultValue: resolved.caseType.code,
            validate(value) {
              return normalizeCode(value) ? undefined : "Enter a case type code.";
            },
          }),
        ),
      );
  const nextName = options?.name
    ? normalizeName(options.name)
    : normalizeName(
        abortIfCancelled(
          await text({
            message: `Name for "${resolved.caseType.name}"`,
            placeholder: resolved.caseType.name,
            defaultValue: resolved.caseType.name,
            validate(value) {
              return normalizeName(value) ? undefined : "Enter a case type name.";
            },
          }),
        ),
      );
  const nextPrefix = options?.prefix
    ? normalizePrefix(options.prefix)
    : normalizePrefix(
        abortIfCancelled(
          await text({
            message: `Case number prefix for "${resolved.caseType.name}"`,
            placeholder: resolved.caseType.caseNumberPrefix,
            defaultValue: resolved.caseType.caseNumberPrefix,
            validate(value) {
              return normalizePrefix(value)
                ? undefined
                : "Enter a case number prefix.";
            },
          }),
        ),
      );

  const [duplicate] = await db
    .select({ id: practiceAreaCaseTypes.id })
    .from(practiceAreaCaseTypes)
    .where(
      and(
        eq(practiceAreaCaseTypes.practiceAreaId, resolved.area.id),
        eq(practiceAreaCaseTypes.code, nextCode),
      ),
    )
    .limit(1);

  if (duplicate && duplicate.id !== resolved.caseType.id) {
    note(`A case type with code "${nextCode}" already exists.`);
    return;
  }

  const [updated] = await db
    .update(practiceAreaCaseTypes)
    .set({
      code: nextCode,
      name: nextName,
      caseNumberPrefix: nextPrefix,
      updatedAt: new Date(),
    })
    .where(eq(practiceAreaCaseTypes.id, resolved.caseType.id))
    .returning();

  if (updated) printCaseTypes([updated]);
};

const promptForDeleteCaseTypeIds = async (practiceAreaId?: string) => {
  const area = await resolvePracticeArea(practiceAreaId);
  if (!area) return [];

  const caseTypes = await getCaseTypes(area.id);
  if (!caseTypes.length) {
    note(`No case types found for ${area.name}.`);
    return [];
  }

  const selectedIds = abortIfCancelled(
    await multiselect({
      message: "Select case types to delete",
      required: true,
      options: caseTypes.map((caseType) => ({
        value: caseType.id,
        label: caseType.name,
        hint: `${caseType.code} (${caseType.caseNumberPrefix})`,
      })),
    }),
  );

  return selectedIds as string[];
};

const deleteCaseTypes = async (practiceAreaId?: string, ids: readonly string[] = []) => {
  const selectedIds = ids.length ? [...ids] : await promptForDeleteCaseTypeIds(practiceAreaId);
  if (!selectedIds.length) return;

  const caseTypes = await db
    .select()
    .from(practiceAreaCaseTypes)
    .where(inArray(practiceAreaCaseTypes.id, selectedIds));

  if (!caseTypes.length) {
    note("No matching case types found.");
    return;
  }

  note(
    caseTypes
      .map((caseType) => `- ${caseType.name} (${caseType.code}, ${caseType.id})`)
      .join("\n"),
    "Deleting case types can affect case creation and existing case filters.",
  );

  const shouldDelete = abortIfCancelled(
    await confirm({
      message: `Delete ${caseTypes.length} case type${caseTypes.length === 1 ? "" : "s"}?`,
      initialValue: false,
    }),
  );

  if (!shouldDelete) {
    note("Nothing deleted.");
    return;
  }

  const deleted = await db
    .delete(practiceAreaCaseTypes)
    .where(
      inArray(
        practiceAreaCaseTypes.id,
        caseTypes.map((caseType) => caseType.id),
      ),
    )
    .returning();

  printCaseTypes(deleted);
};

const seedDemoData = async (organizationId?: string) => {
  assertDevelopment();

  const firm = await resolveFirm(organizationId);
  if (!firm) return;

  note(
    `This will add linked demo data for ${firm.firmName}. Existing data will not be deleted.`,
    "Development-only demo seed",
  );

  const shouldSeed = abortIfCancelled(
    await confirm({
      message: "Continue?",
      initialValue: false,
    }),
  );

  if (!shouldSeed) {
    note("Nothing seeded.");
    return;
  }

  const suffix = `${slugify(firm.firmName) || "firm"}-${Date.now()}`;
  const emailDomain = "demo.oravanti.test";

  const result = await db.transaction(async (tx) => {
    let [immigrationPracticeArea] = await tx
      .select()
      .from(practiceAreas)
      .where(ilike(practiceAreas.name, "Immigration"))
      .limit(1);

    if (!immigrationPracticeArea) {
      [immigrationPracticeArea] = await tx
        .insert(practiceAreas)
        .values({ name: "Immigration" })
        .returning();
    }

    const caseTypeRows = [];
    for (const caseType of DEFAULT_IMMIGRATION_CASE_TYPES) {
      const [existingCaseType] = await tx
        .select()
        .from(practiceAreaCaseTypes)
        .where(
          and(
            eq(practiceAreaCaseTypes.practiceAreaId, immigrationPracticeArea.id),
            eq(practiceAreaCaseTypes.code, caseType.code),
          ),
        )
        .limit(1);

      if (existingCaseType) {
        caseTypeRows.push(existingCaseType);
        continue;
      }

      const [createdCaseType] = await tx
        .insert(practiceAreaCaseTypes)
        .values({
          practiceAreaId: immigrationPracticeArea.id,
          code: caseType.code,
          name: caseType.name,
          caseNumberPrefix: caseType.caseNumberPrefix,
        })
        .returning();
      caseTypeRows.push(createdCaseType);
    }

    const [existingSubscription] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, firm.id),
          eq(subscriptions.practiceAreaId, immigrationPracticeArea.id),
          eq(subscriptions.status, SubscriptionStatus.ACTIVE),
        ),
      )
      .limit(1);

    const [activeSubscription] = existingSubscription
      ? [existingSubscription]
      : await tx
          .insert(subscriptions)
          .values({
            organizationId: firm.id,
            practiceAreaId: immigrationPracticeArea.id,
            status: SubscriptionStatus.ACTIVE,
            billingCycle: "monthly",
            startsAt: new Date(),
            paymentProvider: "demo",
            providerSubscriptionId: `demo-sub-${suffix}`,
          })
          .returning();

    const [existingFirmPracticeArea] = await tx
      .select()
      .from(firmPracticeAreas)
      .where(
        and(
          eq(firmPracticeAreas.organizationId, firm.id),
          eq(firmPracticeAreas.practiceAreaId, immigrationPracticeArea.id),
          eq(firmPracticeAreas.active, true),
        ),
      )
      .limit(1);

    if (!existingFirmPracticeArea) {
      await tx.insert(firmPracticeAreas).values({
        organizationId: firm.id,
        practiceAreaId: immigrationPracticeArea.id,
        subscriptionId: activeSubscription.id,
        active: true,
      });
    }

    let [firmAdmin] = await tx
      .select()
      .from(admins)
      .where(eq(admins.organizationId, firm.id))
      .limit(1);

    if (!firmAdmin) {
      [firmAdmin] = await tx
        .insert(admins)
        .values({
          organizationId: firm.id,
          userId: randomUUID(),
          firstName: "Demo",
          lastName: "Admin",
          email: `demo.admin.${suffix}@${emailDomain}`,
        })
        .returning();
    }

    const createdStaff = await tx
      .insert(staff)
      .values([
        {
          organizationId: firm.id,
          firstName: "Amara",
          lastName: "Okafor",
          email: `amara.okafor.${suffix}@${emailDomain}`,
          phone: "+1-555-0101",
          role: "attorney",
          status: "active",
          maxCaseload: 12,
          startDate: isoDateFromNow(-600),
          performanceScore: 94,
          certificationsCount: 3,
          activeCases: 2,
          totalCases: 48,
          monthlySalary: "9200",
          hourlyRate: "125",
        },
        {
          organizationId: firm.id,
          firstName: "Noah",
          lastName: "Reed",
          email: `noah.reed.${suffix}@${emailDomain}`,
          phone: "+1-555-0102",
          role: "senior_paralegal",
          status: "active",
          maxCaseload: 15,
          startDate: isoDateFromNow(-420),
          performanceScore: 88,
          certificationsCount: 2,
          activeCases: 3,
          totalCases: 35,
          monthlySalary: "6200",
          hourlyRate: "75",
        },
        {
          organizationId: firm.id,
          firstName: "Mia",
          lastName: "Chen",
          email: `mia.chen.${suffix}@${emailDomain}`,
          phone: "+1-555-0103",
          role: "paralegal",
          status: "active",
          maxCaseload: 10,
          startDate: isoDateFromNow(-180),
          performanceScore: 81,
          certificationsCount: 1,
          activeCases: 1,
          totalCases: 14,
          monthlySalary: "4800",
          hourlyRate: "55",
        },
      ])
      .returning();

    const attorney = createdStaff[0];
    const seniorParalegal = createdStaff[1];
    const paralegal = createdStaff[2];

    const [demoTeam] = await tx
      .insert(teams)
      .values({
        organizationId: firm.id,
        name: `Demo Immigration Team ${suffix}`,
        leadId: attorney.id,
        description: "Demo team for immigration case workflows.",
        maxCaseload: 40,
        workloadPercentage: 55,
        status: "available",
        activeCases: 3,
      })
      .returning();

    await tx.insert(teamMembers).values(
      createdStaff.map((staffMember) => ({
        teamId: demoTeam.id,
        staffId: staffMember.id,
      })),
    );

    const [demoCompany] = await tx
      .insert(companies)
      .values({
        organizationId: firm.id,
        companyName: `Northstar Robotics Demo ${suffix}`,
        companyType: "corporation",
        ein: `99-${String(Date.now()).slice(-7)}`,
        industry: "Technology",
        numberOfEmployees: 180,
        address: "120 Market Street",
        city: "Austin",
        state: "TX",
        zipCode: "78701",
        country: "United States",
        phone: "+1-555-0200",
        website: "https://northstar-robotics.example",
        primaryContactName: "Priya Raman",
        primaryContactEmail: `priya.raman.${suffix}@${emailDomain}`,
        primaryContactPhone: "+1-555-0201",
        status: "active",
      })
      .returning();

    const createdClients = await tx
      .insert(clients)
      .values([
        {
          organizationId: firm.id,
          firstName: "Sofia",
          lastName: "Martinez",
          email: `sofia.martinez.${suffix}@${emailDomain}`,
          phone: "+1-555-0301",
          dateOfBirth: "1990-04-12",
          nationality: "Mexican",
          countryOfOrigin: "Mexico",
          passportNumber: `MX${String(Date.now()).slice(-7)}`,
          currentAddress: "55 Lake View Dr, Austin, TX",
          clientType: "individual",
          status: "active",
        },
        {
          organizationId: firm.id,
          firstName: "Daniel",
          lastName: "Kim",
          email: `daniel.kim.${suffix}@${emailDomain}`,
          phone: "+1-555-0302",
          dateOfBirth: "1986-11-02",
          nationality: "South Korean",
          countryOfOrigin: "South Korea",
          passportNumber: `KR${String(Date.now()).slice(-7)}`,
          currentAddress: "98 Cedar Lane, Dallas, TX",
          clientType: "individual",
          status: "active",
        },
        {
          organizationId: firm.id,
          firstName: "Priya",
          lastName: "Raman",
          email: `client.priya.raman.${suffix}@${emailDomain}`,
          phone: "+1-555-0303",
          dateOfBirth: "1988-07-20",
          nationality: "Indian",
          countryOfOrigin: "India",
          passportNumber: `IN${String(Date.now()).slice(-7)}`,
          currentAddress: "120 Market Street, Austin, TX",
          clientType: "company_representative",
          companyId: demoCompany.id,
          status: "active",
        },
      ])
      .returning();

    const caseTypeByCode = new Map(
      caseTypeRows.map((caseType) => [caseType.code, caseType]),
    );
    const h1bCaseType = caseTypeByCode.get("h1b_visa")!;
    const familyCaseType = caseTypeByCode.get("family_petition")!;
    const greenCardCaseType = caseTypeByCode.get("green_card")!;

    const createdCases = await tx
      .insert(cases)
      .values([
        {
          organizationId: firm.id,
          caseNumber: `2026-${h1bCaseType.caseNumberPrefix}-DEMO-${suffix}-001`,
          clientId: createdClients[2].id,
          practiceAreaId: immigrationPracticeArea.id,
          caseType: h1bCaseType.code,
          status: "active",
          priority: "high",
          assignmentType: "internal_team",
          teamId: demoTeam.id,
          assignedStaffId: attorney.id,
          requiredCertifications: ["immigration_forms"],
          caseProgress: 45,
          filingDate: isoDateFromNow(-15),
          estimatedCompletionDate: isoDateFromNow(60),
          nextAppointment: isoDateFromNow(10),
          description: "Demo H-1B petition for a robotics engineer.",
          notes: "Employer packet received; review supporting documents.",
          currentEmployer: demoCompany.companyName,
          createdByAdminId: firmAdmin.id,
        },
        {
          organizationId: firm.id,
          caseNumber: `2026-${familyCaseType.caseNumberPrefix}-DEMO-${suffix}-002`,
          clientId: createdClients[0].id,
          practiceAreaId: immigrationPracticeArea.id,
          caseType: familyCaseType.code,
          status: "pending_review",
          priority: "medium",
          assignmentType: "internal_team",
          teamId: demoTeam.id,
          assignedStaffId: seniorParalegal.id,
          requiredCertifications: ["family_petitions"],
          caseProgress: 25,
          filingDate: isoDateFromNow(-5),
          estimatedCompletionDate: isoDateFromNow(90),
          nextAppointment: isoDateFromNow(14),
          description: "Demo family petition case awaiting evidence review.",
          notes: "Collect marriage certificate translation.",
          createdByAdminId: firmAdmin.id,
        },
        {
          organizationId: firm.id,
          caseNumber: `2026-${greenCardCaseType.caseNumberPrefix}-DEMO-${suffix}-003`,
          clientId: createdClients[1].id,
          practiceAreaId: immigrationPracticeArea.id,
          caseType: greenCardCaseType.code,
          status: "active",
          priority: "medium",
          assignmentType: "internal_team",
          teamId: demoTeam.id,
          assignedStaffId: paralegal.id,
          requiredCertifications: ["adjustment_of_status"],
          caseProgress: 60,
          filingDate: isoDateFromNow(-45),
          estimatedCompletionDate: isoDateFromNow(120),
          nextAppointment: isoDateFromNow(21),
          description: "Demo adjustment of status case with interview upcoming.",
          notes: "Prepare interview checklist.",
          createdByAdminId: firmAdmin.id,
        },
      ])
      .returning();

    const createdDocuments = await tx
      .insert(documents)
      .values([
        {
          organizationId: firm.id,
          clientId: createdClients[2].id,
          caseId: createdCases[0].id,
          uploadedById: attorney.id,
          name: "H-1B Employer Support Letter",
          category: "supporting",
          fileUrl: `https://demo.oravanti.test/documents/${suffix}/h1b-support-letter.pdf`,
          storagePath: `${firm.id}/${createdClients[2].id}/${createdCases[0].id}/supporting/h1b-support-letter.pdf`,
          fileSize: 245760,
          mimeType: "application/pdf",
          status: "review_needed",
          aiChecked: true,
        },
        {
          organizationId: firm.id,
          clientId: createdClients[0].id,
          caseId: createdCases[1].id,
          uploadedById: seniorParalegal.id,
          name: "Family Petition Evidence Packet",
          category: "application",
          fileUrl: `https://demo.oravanti.test/documents/${suffix}/family-petition.pdf`,
          storagePath: `${firm.id}/${createdClients[0].id}/${createdCases[1].id}/application/family-petition.pdf`,
          fileSize: 389120,
          mimeType: "application/pdf",
          status: "processing",
          aiChecked: false,
        },
        {
          organizationId: firm.id,
          clientId: createdClients[1].id,
          caseId: createdCases[2].id,
          uploadedById: paralegal.id,
          name: "Green Card Identity Documents",
          category: "identity",
          fileUrl: `https://demo.oravanti.test/documents/${suffix}/identity-documents.pdf`,
          storagePath: `${firm.id}/${createdClients[1].id}/${createdCases[2].id}/identity/identity-documents.pdf`,
          fileSize: 198656,
          mimeType: "application/pdf",
          status: "approved",
          aiChecked: true,
        },
      ])
      .returning();

    const createdTasks = await tx
      .insert(tasks)
      .values([
        {
          organizationId: firm.id,
          title: "Review H-1B support letter",
          description: "Confirm role duties, wage details, and employer signature.",
          caseId: createdCases[0].id,
          teamId: demoTeam.id,
          assignedToId: attorney.id,
          assignedById: firmAdmin.id,
          dueDate: isoDateFromNow(3),
          priority: "high",
          status: "in_progress",
          progress: 35,
          requiredCertifications: ["immigration_forms"],
        },
        {
          organizationId: firm.id,
          title: "Request translated marriage certificate",
          description: "Send client request for certified translation.",
          caseId: createdCases[1].id,
          teamId: demoTeam.id,
          assignedToId: seniorParalegal.id,
          assignedById: firmAdmin.id,
          dueDate: isoDateFromNow(5),
          priority: "medium",
          status: "pending",
          progress: 0,
          requiredCertifications: ["family_petitions"],
        },
        {
          organizationId: firm.id,
          title: "Prepare interview checklist",
          description: "Build client-facing checklist for adjustment interview.",
          caseId: createdCases[2].id,
          teamId: demoTeam.id,
          assignedToId: paralegal.id,
          assignedById: firmAdmin.id,
          dueDate: isoDateFromNow(8),
          priority: "medium",
          status: "in_progress",
          progress: 60,
          requiredCertifications: ["adjustment_of_status"],
        },
      ])
      .returning();

    const createdCalendarEvents = await tx
      .insert(calendarEvents)
      .values([
        {
          organizationId: firm.id,
          eventType: "client_meeting",
          status: "scheduled",
          title: "H-1B Filing Strategy Call",
          startTime: timestampFromNow(4, 15),
          endTime: timestampFromNow(4, 16),
          clientId: createdClients[2].id,
          caseId: createdCases[0].id,
          assignedStaffId: attorney.id,
          teamId: demoTeam.id,
          location: "Zoom",
          zoomLink: "https://zoom.example/demo-h1b",
          notes: "Walk through employer timeline and premium processing.",
          isAutoGenerated: false,
        },
        {
          organizationId: firm.id,
          eventType: "uscis_interview",
          status: "scheduled",
          title: "Green Card Interview Prep",
          startTime: timestampFromNow(18, 10),
          endTime: timestampFromNow(18, 11),
          clientId: createdClients[1].id,
          caseId: createdCases[2].id,
          assignedStaffId: paralegal.id,
          teamId: demoTeam.id,
          location: "Office",
          notes: "Mock interview and document review.",
          isAutoGenerated: false,
        },
      ])
      .returning();

    const createdClientRequests = await tx
      .insert(clientRequests)
      .values([
        {
          organizationId: firm.id,
          clientId: createdClients[0].id,
          caseId: createdCases[1].id,
          description: "Upload certified translation of marriage certificate.",
          requestedAt: isoDateFromNow(0),
          status: "pending",
        },
        {
          organizationId: firm.id,
          clientId: createdClients[2].id,
          caseId: createdCases[0].id,
          description: "Confirm latest job description and worksite address.",
          requestedAt: isoDateFromNow(-1),
          status: "fulfilled",
        },
      ])
      .returning();

    const createdTimeEntries = await tx
      .insert(timeEntries)
      .values([
        {
          organizationId: firm.id,
          staffId: attorney.id,
          caseId: createdCases[0].id,
          hoursWorked: "2.50",
          entryDate: isoDateFromNow(-2),
          description: "Reviewed H-1B support materials.",
        },
        {
          organizationId: firm.id,
          staffId: seniorParalegal.id,
          caseId: createdCases[1].id,
          hoursWorked: "1.75",
          entryDate: isoDateFromNow(-1),
          description: "Prepared family petition evidence checklist.",
        },
        {
          organizationId: firm.id,
          staffId: paralegal.id,
          caseId: createdCases[2].id,
          hoursWorked: "3.00",
          entryDate: isoDateFromNow(0),
          description: "Compiled green card interview packet.",
        },
      ])
      .returning();

    const [existingAiConfig] = await tx
      .select()
      .from(aiSystemConfig)
      .where(eq(aiSystemConfig.organizationId, firm.id))
      .limit(1);

    if (existingAiConfig) {
      await tx
        .update(aiSystemConfig)
        .set({
          isActive: true,
          crossCheckingEnabled: true,
          inaValidationActive: true,
          realtimeAnalysis: true,
          updatedAt: new Date(),
        })
        .where(eq(aiSystemConfig.id, existingAiConfig.id));
    } else {
      await tx.insert(aiSystemConfig).values({
        organizationId: firm.id,
        isActive: true,
        crossCheckingEnabled: true,
        inaValidationActive: true,
        realtimeAnalysis: true,
      });
    }

    const createdAiErrorFlags = await tx
      .insert(aiErrorFlags)
      .values([
        {
          organizationId: firm.id,
          clientId: createdClients[2].id,
          caseId: createdCases[0].id,
          documentId: createdDocuments[0].id,
          title: "Employer letter missing worksite detail",
          description:
            "Demo AI review found that the support letter does not list the exact worksite address.",
          severity: "medium",
          status: "pending_review",
          affectedField: "worksite_address",
          documentRef: createdDocuments[0].name,
        },
      ])
      .returning();

    return {
      firm: {
        id: firm.id,
        firmName: firm.firmName,
      },
      practiceArea: {
        id: immigrationPracticeArea.id,
        name: immigrationPracticeArea.name,
      },
      subscriptionId: activeSubscription.id,
      adminId: firmAdmin.id,
      staffCount: createdStaff.length,
      teamId: demoTeam.id,
      companyId: demoCompany.id,
      clientCount: createdClients.length,
      caseCount: createdCases.length,
      documentCount: createdDocuments.length,
      taskCount: createdTasks.length,
      calendarEventCount: createdCalendarEvents.length,
      clientRequestCount: createdClientRequests.length,
      timeEntryCount: createdTimeEntries.length,
      aiErrorFlagCount: createdAiErrorFlags.length,
    } satisfies DemoSeedResult;
  });

  printDemoSeedResult(result);
};

const editPracticeArea = async (id?: string, name?: string) => {
  const area = await resolvePracticeArea(id);

  if (!area) return;

  const nextName = name
    ? normalizeName(name)
    : normalizeName(
        abortIfCancelled(
          await text({
            message: `Rename "${area.name}"`,
            placeholder: area.name,
            validate(value) {
              return normalizeName(value) ? undefined : "Enter a practice area name.";
            },
          }),
        ),
      );

  if (!nextName) {
    note("No name provided.");
    return;
  }

  const [duplicate] = await db
    .select({ id: practiceAreas.id })
    .from(practiceAreas)
    .where(ilike(practiceAreas.name, nextName))
    .limit(1);

  if (duplicate && duplicate.id !== area.id) {
    note(`A practice area named "${nextName}" already exists.`);
    return;
  }

  const [updated] = await db
    .update(practiceAreas)
    .set({ name: nextName, updatedAt: new Date() })
    .where(eq(practiceAreas.id, area.id))
    .returning();

  if (updated) printPracticeAreas([updated]);
};

const promptForDeleteIds = async () => {
  const areas = await getPracticeAreas();

  if (!areas.length) {
    note("No practice areas found.");
    return [];
  }

  const selectedIds = abortIfCancelled(
    await multiselect({
      message: "Select practice areas to delete",
      required: true,
      options: areas.map((area) => ({
        value: area.id,
        label: area.name,
        hint: area.id,
      })),
    }),
  );

  return selectedIds as string[];
};

const deletePracticeAreas = async (ids: readonly string[]) => {
  const selectedIds = ids.length ? [...ids] : await promptForDeleteIds();

  if (!selectedIds.length) return;

  const areas = await db
    .select()
    .from(practiceAreas)
    .where(inArray(practiceAreas.id, selectedIds));

  if (!areas.length) {
    note("No matching practice areas found.");
    return;
  }

  note(
    areas.map((area) => `- ${area.name} (${area.id})`).join("\n"),
    "Deleting practice areas can affect firms, cases, and subscriptions that reference them.",
  );

  const shouldDelete = abortIfCancelled(
    await confirm({
      message: `Delete ${areas.length} practice area${areas.length === 1 ? "" : "s"}?`,
      initialValue: false,
    }),
  );

  if (!shouldDelete) {
    note("Nothing deleted.");
    return;
  }

  const deleted = await db
    .delete(practiceAreas)
    .where(
      inArray(
        practiceAreas.id,
        areas.map((area) => area.id),
      ),
    )
    .returning();

  printPracticeAreas(deleted);
};

const runInteractive = async () => {
  intro("Practice area admin");

  const action = abortIfCancelled(
    await select({
      message: "What do you want to do?",
      options: [
        { value: "list", label: "Fetch practice areas" },
        { value: "create", label: "Create practice areas" },
        { value: "defaults", label: "Create default practice areas" },
        { value: "edit", label: "Edit a practice area" },
        { value: "delete", label: "Delete practice areas" },
        { value: "case-types-list", label: "Fetch case types" },
        { value: "case-types-create", label: "Create case types" },
        { value: "case-types-defaults", label: "Create Immigration case types" },
        { value: "case-types-edit", label: "Edit a case type" },
        { value: "case-types-delete", label: "Delete case types" },
        { value: "demo-data", label: "Seed demo data for a firm" },
      ],
    }),
  );

  if (action === "list") {
    printPracticeAreas(await getPracticeAreas());
  }

  if (action === "create") {
    await createPracticeAreas(await promptForNames());
  }

  if (action === "defaults") {
    await createPracticeAreas(DEFAULT_PRACTICE_AREAS);
  }

  if (action === "edit") {
    await editPracticeArea();
  }

  if (action === "delete") {
    await deletePracticeAreas([]);
  }

  if (action === "case-types-list") {
    const area = await resolvePracticeArea();
    if (area) printCaseTypes(await getCaseTypes(area.id));
  }

  if (action === "case-types-create") {
    const area = await resolvePracticeArea();
    if (area) await createCaseTypes(area.id, await promptForCaseTypeDefinitions());
  }

  if (action === "case-types-defaults") {
    await createDefaultImmigrationCaseTypes();
  }

  if (action === "case-types-edit") {
    await editCaseType();
  }

  if (action === "case-types-delete") {
    await deleteCaseTypes();
  }

  if (action === "demo-data") {
    await seedDemoData();
  }

  outro("Done.");
};

const runWithSpinner = async (message: string, action: () => Promise<void>) => {
  const s = spinner();
  s.start(message);

  try {
    await action();
    s.stop("Done.");
  } catch (error) {
    s.stop("Failed.");
    throw error;
  }
};

program
  .name("practice-areas")
  .description("Manage global practice areas for service admins")
  .action(runInteractive);

program
  .command("list")
  .description("Fetch all practice areas")
  .action(async () => {
    await runWithSpinner("Fetching practice areas", async () => {
      printPracticeAreas(await getPracticeAreas());
    });
  });

program
  .command("create")
  .description("Create one or more practice areas")
  .argument("[names...]", "Practice area names")
  .option("--defaults", "Create the default practice areas")
  .action(async (names: string[], options: { defaults?: boolean }) => {
    const namesToCreate = options.defaults
      ? DEFAULT_PRACTICE_AREAS
      : names.length
        ? names
        : await promptForNames();

    await createPracticeAreas(namesToCreate);
  });

program
  .command("edit")
  .description("Edit a practice area")
  .argument("[id]", "Practice area id")
  .argument("[name]", "New practice area name")
  .action(editPracticeArea);

program
  .command("delete")
  .description("Delete one or more practice areas with confirmation")
  .argument("[ids...]", "Practice area ids")
  .action(deletePracticeAreas);

const caseTypesCommand = program
  .command("case-types")
  .description("Manage case types for a practice area");

caseTypesCommand
  .command("list")
  .description("Fetch case types for a practice area")
  .argument("[practiceAreaId]", "Practice area id")
  .action(async (practiceAreaId?: string) => {
    const area = await resolvePracticeArea(practiceAreaId);
    if (area) printCaseTypes(await getCaseTypes(area.id));
  });

caseTypesCommand
  .command("add")
  .description("Add one or more case types as code|Name|PREFIX")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[definitions...]", "Case type definitions")
  .action(async (practiceAreaId?: string, definitions: string[] = []) => {
    const definitionsToCreate = definitions.length
      ? definitions
      : await promptForCaseTypeDefinitions();

    await createCaseTypes(practiceAreaId, definitionsToCreate);
  });

caseTypesCommand
  .command("add-immigration-defaults")
  .description("Add the existing immigration case types to Immigration or a practice area id")
  .argument("[practiceAreaId]", "Practice area id")
  .action(createDefaultImmigrationCaseTypes);

caseTypesCommand
  .command("edit")
  .description("Edit a case type")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[caseTypeId]", "Case type id")
  .option("-c, --code <code>", "Case type code")
  .option("-n, --name <name>", "Case type name")
  .option("-p, --prefix <prefix>", "Case number prefix")
  .action(editCaseType);

caseTypesCommand
  .command("delete")
  .description("Delete one or more case types with confirmation")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[ids...]", "Case type ids")
  .action(deleteCaseTypes);

const demoDataCommand = program
  .command("demo-data")
  .description("Development-only demo data tools");

demoDataCommand
  .command("seed")
  .description("Select a firm and populate linked demo data")
  .argument("[organizationId]", "Firm id")
  .action(seedDemoData);

program
  .parseAsync(process.argv)
  .catch((error) => {
    if (error instanceof Error && error.message === "cancelled") return;
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
