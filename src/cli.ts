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
import { createHash, randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, ilike, or } from "drizzle-orm";
import { env } from "./config/env";
import { closeDb, db } from "./db/client";
import { admins } from "./db/schema/admins";
import { aiErrorFlags } from "./db/schema/ai-error-flags";
import { aiSystemConfig } from "./db/schema/ai-system-config";
import { assignments } from "./db/schema/assignments";
import {
  member,
  organization as organizations,
  user,
} from "./db/schema/auth-schema";
import { calendarEvents } from "./db/schema/calendar-events";
import { cases } from "./db/schema/cases";
import { certifications } from "./db/schema/certifications";
import { clientRequests } from "./db/schema/client-requests";
import { clients } from "./db/schema/clients";
import { clientCompanies } from "./db/schema/client-companies";
import { contractors } from "./db/schema/contractors";
import {
  documentAccess,
  documentActivityLogs,
  documentCaseLinks,
  documentRequests,
  documents,
  documentVersions,
  externalSubmissions,
} from "./db/schema/documents";
import { adverseParties } from "./db/schema/adverse-parties";
import { clientContacts } from "./db/schema/client-contacts";
import { conflictChecks } from "./db/schema/conflict-checks";
import { consultations } from "./db/schema/consultations";
import { feeAgreements } from "./db/schema/fee-agreements";
import { firmPracticeAreas } from "./db/schema/firm-practice-areas";
import { leads } from "./db/schema/leads";
import { leaveRequests } from "./db/schema/leave-requests";
import {
  caseTypeQuestionnaires,
  caseTypeQuestionnaireSections,
  caseTypeQuestionnaireQuestions,
  caseTypeQuestionnaireLogicRules,
  firmQuestionnaireSections,
  firmQuestionnaireQuestions,
  firmQuestionnaireLogicRules,
  questionnaireSends,
  questionnaireResponses,
  questionnaireAnswers,
  questionnaireResponseFiles,
} from "./db/schema/questionnaires";
import {
  workflowTemplates,
  workflowTemplateSteps,
  caseWorkflowSteps,
} from "./db/schema/workflow";
import { paralegalProfiles } from "./db/schema/paralegal-profiles";
import { practiceAreaCaseTypes } from "./db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "./db/schema/practice-area-subcategories";
import { practiceAreas } from "./db/schema/practice-areas";
import { PRACTICE_AREA_TAXONOMY } from "./db/seeds/practice-area-taxonomy.seed";
import { seedSystemQuestionnaires } from "./db/seeds/system-questionnaires.seed";
import { profiles } from "./db/schema/profiles";
import { staff } from "./db/schema/staff";
import { staffCertifications } from "./db/schema/staff-certifications";
import { subscriptions, SubscriptionStatus } from "./db/schema/subscriptions";
import { tasks } from "./db/schema/tasks";
import { teamMembers } from "./db/schema/team-members";
import { teams } from "./db/schema/teams";
import { timeEntries } from "./db/schema/time-entries";

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
].map((caseType) => ({ ...caseType, jurisdiction: "federal" as const }));

type PracticeAreaRow = typeof practiceAreas.$inferSelect;
type PracticeAreaSubcategoryRow = typeof practiceAreaSubcategories.$inferSelect;
type PracticeAreaCaseTypeRow = typeof practiceAreaCaseTypes.$inferSelect;
type CertificationRow = typeof certifications.$inferSelect;
type StaffRow = typeof staff.$inferSelect;
type NewAssignmentRow = typeof assignments.$inferInsert;
type NewCalendarEventRow = typeof calendarEvents.$inferInsert;
type NewClientRequestRow = typeof clientRequests.$inferInsert;
type NewClientRow = typeof clients.$inferInsert;
type NewClientCompanyRow = typeof clientCompanies.$inferInsert;
type NewClientContactRow = typeof clientContacts.$inferInsert;
type NewContractorRow = typeof contractors.$inferInsert;
type NewDocumentRow = typeof documents.$inferInsert;
type NewDocumentAccessRow = typeof documentAccess.$inferInsert;
type NewDocumentActivityLogRow = typeof documentActivityLogs.$inferInsert;
type NewDocumentCaseLinkRow = typeof documentCaseLinks.$inferInsert;
type NewDocumentVersionRow = typeof documentVersions.$inferInsert;
type NewLeadRow = typeof leads.$inferInsert;
type NewConflictCheckRow = typeof conflictChecks.$inferInsert;
type NewConsultationRow = typeof consultations.$inferInsert;
type NewFeeAgreementRow = typeof feeAgreements.$inferInsert;
type NewLeaveRequestRow = typeof leaveRequests.$inferInsert;
type NewParalegalProfileRow = typeof paralegalProfiles.$inferInsert;
type NewTaskRow = typeof tasks.$inferInsert;
type NewTimeEntryRow = typeof timeEntries.$inferInsert;
type NewTeamRow = typeof teams.$inferInsert;
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
  jurisdiction: CaseTypeJurisdictionInput;
};

type CaseTypeJurisdictionInput =
  | "federal"
  | "state"
  | "federal & state"
  | "varies";

type DemoSeedResult = {
  firm: Pick<FirmRow, "id" | "firmName">;
  practiceAreaCount: number;
  caseTypeCount: number;
  subscriptionCount: number;
  firmPracticeAreaCount: number;
  adminId: string;
  userCount: number;
  memberCount: number;
  profileCount: number;
  staffCount: number;
  certificationCount: number;
  staffCertificationCount: number;
  paralegalProfileCount: number;
  teamCount: number;
  teamMemberCount: number;
  companyCount: number;
  clientCount: number;
  caseCount: number;
  leadCount: number;
  conflictCheckCount: number;
  consultationCount: number;
  feeAgreementCount: number;
  contractorCount: number;
  assignmentCount: number;
  documentCount: number;
  taskCount: number;
  calendarEventCount: number;
  clientRequestCount: number;
  timeEntryCount: number;
  leaveRequestCount: number;
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
const normalizeJurisdiction = (
  value?: string,
): CaseTypeJurisdictionInput | null => {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");

  if (!normalized) return null;
  if (normalized === "federal") return "federal";
  if (normalized === "state") return "state";
  if (normalized === "federal & state" || normalized === "federal and state") {
    return "federal & state";
  }
  if (normalized === "varies") return "varies";

  return null;
};
const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
const hashSuffix = (value: string, length = 8) =>
  createHash("sha1").update(value).digest("hex").slice(0, length);
const codeFromParts = (...parts: string[]) => {
  const base = parts.map(slugify).filter(Boolean).join("_").slice(0, 90);
  return `${base}_${hashSuffix(parts.join("|"))}`.slice(0, 100);
};
const prefixFromName = (name: string) => {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const initials = words
    .slice(0, 4)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  const fallback = slugify(name).replace(/-/g, "").slice(0, 4).toUpperCase();
  return `${initials || fallback || "CASE"}${hashSuffix(name, 4).toUpperCase()}`.slice(
    0,
    20,
  );
};

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
  if (env.NODE_ENV !== "development") {
    throw new Error("Demo data seeding is only available in development.");
  }
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

const getSubcategories = (practiceAreaId: string) =>
  db
    .select()
    .from(practiceAreaSubcategories)
    .where(eq(practiceAreaSubcategories.practiceAreaId, practiceAreaId))
    .orderBy(asc(practiceAreaSubcategories.name));

const getCaseTypes = (subcategoryId: string) =>
  db
    .select()
    .from(practiceAreaCaseTypes)
    .where(eq(practiceAreaCaseTypes.subcategoryId, subcategoryId))
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
      practiceAreas: result.practiceAreaCount,
      caseTypes: result.caseTypeCount,
      subscriptions: result.subscriptionCount,
      firmPracticeAreas: result.firmPracticeAreaCount,
      adminId: result.adminId,
      users: result.userCount,
      members: result.memberCount,
      profiles: result.profileCount,
      staff: result.staffCount,
      certifications: result.certificationCount,
      staffCertifications: result.staffCertificationCount,
      paralegalProfiles: result.paralegalProfileCount,
      teams: result.teamCount,
      teamMembers: result.teamMemberCount,
      companies: result.companyCount,
      clients: result.clientCount,
      cases: result.caseCount,
      contractors: result.contractorCount,
      assignments: result.assignmentCount,
      documents: result.documentCount,
      tasks: result.taskCount,
      calendarEvents: result.calendarEventCount,
      clientRequests: result.clientRequestCount,
      timeEntries: result.timeEntryCount,
      leaveRequests: result.leaveRequestCount,
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
      subcategoryId: caseType.subcategoryId,
      code: caseType.code,
      name: caseType.name,
      caseNumberPrefix: caseType.caseNumberPrefix,
      jurisdiction: caseType.jurisdiction,
      createdAt: caseType.createdAt.toISOString(),
      updatedAt: caseType.updatedAt.toISOString(),
    })),
  );
};

const printSubcategories = (subcategories: PracticeAreaSubcategoryRow[]) => {
  if (!subcategories.length) {
    note("No practice area subcategories found.");
    return;
  }

  console.table(
    subcategories.map((subcategory) => ({
      id: subcategory.id,
      practiceAreaId: subcategory.practiceAreaId,
      code: subcategory.code,
      name: subcategory.name,
      createdAt: subcategory.createdAt.toISOString(),
      updatedAt: subcategory.updatedAt.toISOString(),
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
            : `${item.code}|${item.name}|${item.caseNumberPrefix}|${item.jurisdiction}`,
        );

  const definitions: CaseTypeInput[] = [];
  const seen = new Set<string>();

  for (const rawDefinition of rawDefinitions) {
    const parts = rawDefinition.split("|").map((part) => part.trim());
    const [rawCode, rawName, rawPrefix, rawJurisdiction] = parts;
    const code = normalizeCode(rawCode ?? "");
    const name = normalizeName(rawName ?? "");
    const caseNumberPrefix = normalizePrefix(rawPrefix ?? "");
    const jurisdiction = normalizeJurisdiction(rawJurisdiction) ?? "varies";

    if (!code || !name || !caseNumberPrefix || seen.has(code)) continue;

    seen.add(code);
    definitions.push({ code, name, caseNumberPrefix, jurisdiction });
  }

  return definitions;
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
  return (
    areas.find((area) => normalizeKey(area.name) === normalizeKey(name)) ?? null
  );
};

const resolveSubcategory = async (
  practiceAreaId?: string,
  subcategoryId?: string,
) => {
  const area = await resolvePracticeArea(practiceAreaId);
  if (!area) return null;

  const subcategories = await getSubcategories(area.id);
  if (!subcategories.length) {
    note(`No subcategories found for ${area.name}.`);
    return null;
  }

  if (subcategoryId) {
    const subcategory = subcategories.find(
      (currentSubcategory) => currentSubcategory.id === subcategoryId,
    );
    if (!subcategory) {
      note(`Subcategory not found: ${subcategoryId}`);
      return null;
    }

    return { area, subcategory };
  }

  const selectedId = abortIfCancelled(
    await select({
      message: "Select a subcategory",
      options: subcategories.map((subcategory) => ({
        value: subcategory.id,
        label: subcategory.name,
        hint: subcategory.code,
      })),
    }),
  );

  const subcategory =
    subcategories.find(
      (currentSubcategory) => currentSubcategory.id === selectedId,
    ) ?? null;

  return subcategory ? { area, subcategory } : null;
};

const promptForCaseTypeDefinitions = async () => {
  const definitions = abortIfCancelled(
    await text({
      message: "Enter case types as code|Name|PREFIX, one per line",
      placeholder: "h1b_visa|H-1B Visa|H1B|federal",
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
  subcategoryId: string | undefined,
  definitions: readonly string[] | readonly CaseTypeInput[],
) => {
  const resolved = await resolveSubcategory(practiceAreaId, subcategoryId);
  if (!resolved) return;

  const parsedDefinitions = parseCaseTypeDefinitions(definitions);
  if (!parsedDefinitions.length) {
    note("No valid case type definitions were provided.");
    return;
  }

  const existingCaseTypes = await getCaseTypes(resolved.subcategory.id);
  const existingCodes = new Set(
    existingCaseTypes.map((caseType) => caseType.code),
  );
  const skipped = parsedDefinitions.filter((item) =>
    existingCodes.has(item.code),
  );
  const definitionsToCreate = parsedDefinitions.filter(
    (item) => !existingCodes.has(item.code),
  );

  if (!definitionsToCreate.length) {
    note(
      `All provided case types already exist: ${skipped.map((item) => item.code).join(", ")}`,
    );
    return;
  }

  const created = await db
    .insert(practiceAreaCaseTypes)
    .values(
      definitionsToCreate.map((item) => ({
        subcategoryId: resolved.subcategory.id,
        code: item.code,
        name: item.name,
        caseNumberPrefix: item.caseNumberPrefix,
        jurisdiction: item.jurisdiction,
      })),
    )
    .returning();

  printCaseTypes(created);

  if (skipped.length) {
    note(
      `Skipped existing case types: ${skipped.map((item) => item.code).join(", ")}`,
    );
  }
};

const createDefaultImmigrationCaseTypes = async (practiceAreaId?: string) => {
  const area = practiceAreaId
    ? await resolvePracticeArea(practiceAreaId)
    : await resolvePracticeAreaByName("Immigration");

  if (!area) {
    note(
      "Immigration practice area not found. Create it first or pass its id.",
    );
    return;
  }

  const [subcategory] = await db
    .insert(practiceAreaSubcategories)
    .values({
      practiceAreaId: area.id,
      code: "general",
      name: "General",
    })
    .onConflictDoUpdate({
      target: [
        practiceAreaSubcategories.practiceAreaId,
        practiceAreaSubcategories.code,
      ],
      set: { name: "General", updatedAt: new Date() },
    })
    .returning();

  await createCaseTypes(
    area.id,
    subcategory.id,
    DEFAULT_IMMIGRATION_CASE_TYPES,
  );
};

const resolveCaseType = async (
  practiceAreaId?: string,
  subcategoryId?: string,
  caseTypeId?: string,
) => {
  const resolved = await resolveSubcategory(practiceAreaId, subcategoryId);
  if (!resolved) return null;

  const caseTypes = await getCaseTypes(resolved.subcategory.id);
  if (!caseTypes.length) {
    note(`No case types found for ${resolved.subcategory.name}.`);
    return null;
  }

  if (caseTypeId) {
    const caseType = caseTypes.find(
      (currentCaseType) => currentCaseType.id === caseTypeId,
    );
    if (!caseType) {
      note(`Case type not found: ${caseTypeId}`);
      return null;
    }

    return { ...resolved, caseType };
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

  const caseType = caseTypes.find(
    (currentCaseType) => currentCaseType.id === selectedId,
  );
  return caseType ? { ...resolved, caseType } : null;
};

const editCaseType = async (
  practiceAreaId?: string,
  subcategoryId?: string,
  caseTypeId?: string,
  options?: {
    code?: string;
    name?: string;
    prefix?: string;
    jurisdiction?: string;
  },
) => {
  const resolved = await resolveCaseType(
    practiceAreaId,
    subcategoryId,
    caseTypeId,
  );
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
              return normalizeCode(value)
                ? undefined
                : "Enter a case type code.";
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
              return normalizeName(value)
                ? undefined
                : "Enter a case type name.";
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
  const nextJurisdiction = options?.jurisdiction
    ? normalizeJurisdiction(options.jurisdiction)
    : normalizeJurisdiction(
        abortIfCancelled(
          await text({
            message: `Jurisdiction for "${resolved.caseType.name}"`,
            placeholder: resolved.caseType.jurisdiction,
            defaultValue: resolved.caseType.jurisdiction,
            validate(value) {
              return normalizeJurisdiction(value)
                ? undefined
                : "Enter federal, state, federal & state, or varies.";
            },
          }),
        ),
      );

  if (!nextJurisdiction) {
    note("Invalid jurisdiction.");
    return;
  }

  const [duplicate] = await db
    .select({ id: practiceAreaCaseTypes.id })
    .from(practiceAreaCaseTypes)
    .where(
      and(
        eq(practiceAreaCaseTypes.subcategoryId, resolved.subcategory.id),
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
      jurisdiction: nextJurisdiction,
      updatedAt: new Date(),
    })
    .where(eq(practiceAreaCaseTypes.id, resolved.caseType.id))
    .returning();

  if (updated) printCaseTypes([updated]);
};

const promptForDeleteCaseTypeIds = async (
  practiceAreaId?: string,
  subcategoryId?: string,
) => {
  const resolved = await resolveSubcategory(practiceAreaId, subcategoryId);
  if (!resolved) return [];

  const caseTypes = await getCaseTypes(resolved.subcategory.id);
  if (!caseTypes.length) {
    note(`No case types found for ${resolved.subcategory.name}.`);
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

const deleteCaseTypes = async (
  practiceAreaId?: string,
  subcategoryId?: string,
  ids: readonly string[] = [],
) => {
  const selectedIds = ids.length
    ? [...ids]
    : await promptForDeleteCaseTypeIds(practiceAreaId, subcategoryId);
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
      .map(
        (caseType) => `- ${caseType.name} (${caseType.code}, ${caseType.id})`,
      )
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

const seedPracticeAreaTaxonomy = async () => {
  const result = await db.transaction(async (tx) => {
    let practiceAreaCount = 0;
    let subcategoryCount = 0;
    let caseTypeCount = 0;

    for (const taxonomyArea of PRACTICE_AREA_TAXONOMY) {
      let [area] = await tx
        .select()
        .from(practiceAreas)
        .where(ilike(practiceAreas.name, taxonomyArea.name))
        .limit(1);

      if (!area) {
        [area] = await tx
          .insert(practiceAreas)
          .values({ name: taxonomyArea.name })
          .returning();
      } else if (area.name !== taxonomyArea.name) {
        [area] = await tx
          .update(practiceAreas)
          .set({ name: taxonomyArea.name, updatedAt: new Date() })
          .where(eq(practiceAreas.id, area.id))
          .returning();
      }

      practiceAreaCount += 1;

      for (const taxonomySubcategory of taxonomyArea.subcategories) {
        const subcategoryCode = codeFromParts(
          taxonomyArea.name,
          taxonomySubcategory.name,
        );
        let [subcategory] = await tx
          .select()
          .from(practiceAreaSubcategories)
          .where(
            and(
              eq(practiceAreaSubcategories.practiceAreaId, area.id),
              eq(practiceAreaSubcategories.code, subcategoryCode),
            ),
          )
          .limit(1);

        if (!subcategory) {
          [subcategory] = await tx
            .insert(practiceAreaSubcategories)
            .values({
              practiceAreaId: area.id,
              code: subcategoryCode,
              name: taxonomySubcategory.name,
            })
            .returning();
        } else if (subcategory.name !== taxonomySubcategory.name) {
          [subcategory] = await tx
            .update(practiceAreaSubcategories)
            .set({ name: taxonomySubcategory.name, updatedAt: new Date() })
            .where(eq(practiceAreaSubcategories.id, subcategory.id))
            .returning();
        }

        subcategoryCount += 1;

        for (const taxonomyCaseType of taxonomySubcategory.caseTypes) {
          const caseTypeCode = codeFromParts(
            taxonomyArea.name,
            taxonomySubcategory.name,
            taxonomyCaseType.name,
          );
          const caseNumberPrefix = prefixFromName(taxonomyCaseType.name);
          const [existingCaseType] = await tx
            .select()
            .from(practiceAreaCaseTypes)
            .where(
              and(
                eq(practiceAreaCaseTypes.subcategoryId, subcategory.id),
                eq(practiceAreaCaseTypes.code, caseTypeCode),
              ),
            )
            .limit(1);

          if (!existingCaseType) {
            await tx.insert(practiceAreaCaseTypes).values({
              subcategoryId: subcategory.id,
              code: caseTypeCode,
              name: taxonomyCaseType.name,
              caseNumberPrefix,
              jurisdiction: taxonomyCaseType.jurisdiction,
            });
          } else {
            await tx
              .update(practiceAreaCaseTypes)
              .set({
                name: taxonomyCaseType.name,
                caseNumberPrefix,
                jurisdiction: taxonomyCaseType.jurisdiction,
                updatedAt: new Date(),
              })
              .where(eq(practiceAreaCaseTypes.id, existingCaseType.id));
          }

          caseTypeCount += 1;
        }
      }
    }

    return { practiceAreaCount, subcategoryCount, caseTypeCount };
  });

  console.table([result]);
};

const DEMO_EMAIL_DOMAIN = "demo.oravanti.test";
const DEMO_TARGETS = {
  staff: 20,
  teams: 15,
  companies: 15,
  clients: 60,
  cases: 100,
  leads: 40,
  contractors: 15,
  assignments: 100,
  documents: 120,
  tasks: 100,
  calendarEvents: 60,
  clientRequests: 60,
  timeEntries: 120,
  leaveRequests: 20,
  aiErrorFlags: 30,
} as const;

const DEMO_CERTIFICATIONS = [
  ["immigration_forms", "Immigration Forms Review", "basic"],
  ["family_petitions", "Family Petition Assembly", "basic"],
  ["adjustment_of_status", "Adjustment of Status", "intermediate"],
  ["business_immigration", "Business Immigration", "advanced"],
  ["asylum_advocacy", "Asylum Advocacy", "advanced"],
  ["naturalization", "Naturalization", "intermediate"],
  ["consular_processing", "Consular Processing", "intermediate"],
  ["removal_defense", "Removal Defense", "expert"],
  ["employment_law", "Employment Law Intake", "intermediate"],
  ["probate_admin", "Probate Administration", "basic"],
  ["civil_discovery", "Civil Discovery", "intermediate"],
  ["corporate_filings", "Corporate Filings", "basic"],
  ["tax_compliance", "Tax Compliance", "advanced"],
  ["healthcare_regulatory", "Healthcare Regulatory", "advanced"],
  ["ip_portfolio", "IP Portfolio Management", "expert"],
] as const;

const DEMO_STAFF = [
  ["Avery", "Stone", "admin"],
  ["Amara", "Okafor", "attorney"],
  ["Noah", "Reed", "attorney"],
  ["Mina", "Patel", "attorney"],
  ["Julian", "Brooks", "attorney"],
  ["Mia", "Chen", "senior_paralegal"],
  ["Daniel", "Kim", "senior_paralegal"],
  ["Sofia", "Martinez", "senior_paralegal"],
  ["Priya", "Raman", "senior_paralegal"],
  ["Mateo", "Rivera", "senior_paralegal"],
  ["Grace", "Taylor", "paralegal"],
  ["Ethan", "Wright", "paralegal"],
  ["Leila", "Hassan", "paralegal"],
  ["Ife", "Adebayo", "paralegal"],
  ["Nora", "Sullivan", "paralegal"],
  ["Zara", "Ahmed", "junior_paralegal"],
  ["Owen", "Carter", "junior_paralegal"],
  ["Nadia", "Silva", "junior_paralegal"],
  ["Caleb", "Morgan", "junior_paralegal"],
  ["Tara", "Singh", "junior_paralegal"],
] as const;

const filingTypes = [
  "I-130",
  "I-485",
  "I-765",
  "I-140",
  "N-400",
  "I-131",
] as const;
const caseStatuses = [
  "active",
  "pending_review",
  "on_hold",
  "completed",
  "cancelled",
] as const;
const casePriorities = ["low", "medium", "high", "critical"] as const;
const documentCategories = [
  "application",
  "supporting",
  "identity",
  "uscis_response",
] as const;
const documentStatuses = ["active", "archived"] as const;
const taskStatuses = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;
const eventTypes = [
  "client_meeting",
  "master_calendar_hearing",
  "individual_hearing",
  "uscis_interview",
  "biometric",
  "filing_deadline",
  "service_request",
  "internal_event",
] as const;
const leaveTypes = ["annual", "sick", "emergency", "unpaid"] as const;
const leaveStatuses = ["pending", "approved", "rejected"] as const;
const errorSeverities = ["critical", "high", "medium", "low"] as const;
const errorStatuses = ["pending_review", "under_review", "resolved"] as const;
const leadSources = [
  "education_flywheel",
  "referral",
  "direct",
  "walk_in",
  "phone_enquiry",
  "client_portal",
] as const;
const leadPipelineStages = [
  "lead_inbox",
  "lead_inbox",
  "lead_inbox",
  "conflict_check",
  "conflict_check",
  "questionnaire",
  "consultation",
  "fee_agreement",
  "case_opening",
] as const;
const conflictCheckStatuses = [
  "pass",
  "pass",
  "needs_review",
  "conflict_found",
] as const;
const consultationStatuses = [
  "completed",
  "completed",
  "scheduled",
  "cancelled",
] as const;
const consultationOutcomes = [
  "proceed",
  "proceed",
  "follow_up",
  "close_no_case",
] as const;
const feeAgreementStatuses = ["draft", "pending_signature", "signed"] as const;

const DEMO_LEAD_NAMES = [
  ["James", "OBrien"],
  ["Amina", "Diallo"],
  ["Carlos", "Reyes"],
  ["Wei", "Zhang"],
  ["Fatou", "Ndiaye"],
  ["Olena", "Kovalenko"],
  ["Ravi", "Sharma"],
  ["Lucia", "Ferreira"],
  ["Ahmed", "AlAmin"],
  ["Ingrid", "Lindqvist"],
] as const;

const pick = <T>(items: readonly T[], index: number) =>
  items[index % items.length];

const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index);

const pad = (value: number, width = 3) => String(value).padStart(width, "0");

const ensureAuthUser = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    jobTitle?: string;
  },
) => {
  const [existingById] = await tx
    .select()
    .from(user)
    .where(eq(user.id, input.id))
    .limit(1);
  if (existingById) return existingById;

  const [existingByEmail] = await tx
    .select()
    .from(user)
    .where(eq(user.email, input.email))
    .limit(1);
  if (existingByEmail) return existingByEmail;

  const [createdUser] = await tx
    .insert(user)
    .values({
      id: input.id,
      name: `${input.firstName} ${input.lastName}`,
      email: input.email,
      emailVerified: true,
    })
    .returning();

  return createdUser;
};

const ensureProfile = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    jobTitle?: string;
  },
) => {
  const [existingByUser] = await tx
    .select()
    .from(profiles)
    .where(eq(profiles.userId, input.userId))
    .limit(1);
  if (existingByUser) return existingByUser;

  const [existingByEmail] = await tx
    .select()
    .from(profiles)
    .where(eq(profiles.email, input.email))
    .limit(1);
  if (existingByEmail) return existingByEmail;

  const [createdProfile] = await tx
    .insert(profiles)
    .values({
      userId: input.userId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      jobTitle: input.jobTitle,
    })
    .returning();

  return createdProfile;
};

const ensureMember = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
) => {
  const [existingMember] = await tx
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  if (existingMember) return existingMember;

  const [createdMember] = await tx
    .insert(member)
    .values({
      id: randomUUID(),
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    })
    .returning();

  return createdMember;
};

const seedDemoData = async (organizationId?: string) => {
  assertDevelopment();

  const firm = await resolveFirm(organizationId);
  if (!firm) return;

  note(
    `This will add a connected demo dataset for ${firm.firmName}. Existing data will not be deleted.`,
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

  const existingPracticeAreas = await db
    .select()
    .from(practiceAreas)
    .orderBy(asc(practiceAreas.name));

  if (!existingPracticeAreas.length) {
    note(
      "No practice areas found. Run 'Seed practice area taxonomy' first.",
      "Missing taxonomy data",
    );
    return;
  }

  const existingCaseTypes = await db
    .select({
      id: practiceAreaCaseTypes.id,
      subcategoryId: practiceAreaCaseTypes.subcategoryId,
      code: practiceAreaCaseTypes.code,
      name: practiceAreaCaseTypes.name,
      caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
      jurisdiction: practiceAreaCaseTypes.jurisdiction,
      createdAt: practiceAreaCaseTypes.createdAt,
      updatedAt: practiceAreaCaseTypes.updatedAt,
      practiceAreaId: practiceAreaSubcategories.practiceAreaId,
    })
    .from(practiceAreaCaseTypes)
    .innerJoin(
      practiceAreaSubcategories,
      eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId),
    );

  if (!existingCaseTypes.length) {
    note(
      "No case types found. Run 'Seed practice area taxonomy' first.",
      "Missing taxonomy data",
    );
    return;
  }

  const suffix = `${slugify(firm.firmName) || "firm"}-${Date.now()}`;

  const result = await db.transaction(async (tx) => {
    const practiceAreaRows = existingPracticeAreas;
    const caseTypeRows = existingCaseTypes;

    const subscriptionRows = [];
    const firmPracticeAreaRows = [];
    for (const [index, area] of practiceAreaRows.entries()) {
      let [activeSubscription] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.organizationId, firm.id),
            eq(subscriptions.practiceAreaId, area.id),
            eq(subscriptions.status, SubscriptionStatus.ACTIVE),
          ),
        )
        .limit(1);

      if (!activeSubscription) {
        [activeSubscription] = await tx
          .insert(subscriptions)
          .values({
            organizationId: firm.id,
            practiceAreaId: area.id,
            status: SubscriptionStatus.ACTIVE,
            billingCycle: index % 3 === 0 ? "annual" : "monthly",
            startsAt: timestampFromNow(-30 - index),
            paymentProvider: "demo",
            providerSubscriptionId: `demo-sub-${suffix}-${pad(index + 1)}`,
          })
          .returning();
      }

      subscriptionRows.push(activeSubscription);

      let [firmPracticeArea] = await tx
        .select()
        .from(firmPracticeAreas)
        .where(
          and(
            eq(firmPracticeAreas.organizationId, firm.id),
            eq(firmPracticeAreas.practiceAreaId, area.id),
            eq(firmPracticeAreas.active, true),
          ),
        )
        .limit(1);

      if (!firmPracticeArea) {
        [firmPracticeArea] = await tx
          .insert(firmPracticeAreas)
          .values({
            organizationId: firm.id,
            practiceAreaId: area.id,
            subscriptionId: activeSubscription.id,
            active: true,
          })
          .returning();
      }

      firmPracticeAreaRows.push(firmPracticeArea);
    }

    const certificationRows: CertificationRow[] = [];
    for (const [code, name, level] of DEMO_CERTIFICATIONS) {
      let [certification] = await tx
        .select()
        .from(certifications)
        .where(eq(certifications.code, code))
        .limit(1);

      if (!certification) {
        [certification] = await tx
          .insert(certifications)
          .values({
            code,
            name,
            level,
            description: `Demo certification for ${name.toLowerCase()}.`,
          })
          .returning();
      }

      certificationRows.push(certification);
    }

    let [firmAdmin] = await tx
      .select()
      .from(admins)
      .where(eq(admins.organizationId, firm.id))
      .limit(1);

    if (!firmAdmin) {
      const adminUserId = `demo-admin-user-${suffix}`;
      const adminEmail = `demo.admin.${suffix}@${DEMO_EMAIL_DOMAIN}`;
      await ensureAuthUser(tx, {
        id: adminUserId,
        firstName: "Demo",
        lastName: "Admin",
        email: adminEmail,
        phone: "+1-555-0100",
        jobTitle: "Firm Administrator",
      });

      [firmAdmin] = await tx
        .insert(admins)
        .values({
          organizationId: firm.id,
          userId: adminUserId,
          firstName: "Demo",
          lastName: "Admin",
          email: adminEmail,
        })
        .returning();
    }

    const adminAuthUser = await ensureAuthUser(tx, {
      id: firmAdmin.userId,
      firstName: firmAdmin.firstName,
      lastName: firmAdmin.lastName,
      email: firmAdmin.email,
      phone: "+1-555-0100",
      jobTitle: "Firm Administrator",
    });
    const adminProfile = await ensureProfile(tx, {
      userId: adminAuthUser.id,
      firstName: firmAdmin.firstName,
      lastName: firmAdmin.lastName,
      email: adminAuthUser.email,
      phone: "+1-555-0100",
      jobTitle: "Firm Administrator",
    });
    const adminMember = await ensureMember(
      tx,
      firm.id,
      adminAuthUser.id,
      "owner",
    );

    const createdUsers = [adminAuthUser];
    const createdProfiles = [adminProfile];
    const createdMembers = [adminMember];
    const createdStaff: StaffRow[] = [];

    for (const [index, [firstName, lastName, role]] of DEMO_STAFF.entries()) {
      const email = `${firstName}.${lastName}.${suffix}`
        .toLowerCase()
        .replace(/[^a-z0-9@.]+/g, ".")
        .concat(`@${DEMO_EMAIL_DOMAIN}`);
      const phone = `+1-555-${pad(1100 + index, 4)}`;
      const authUser = await ensureAuthUser(tx, {
        id: `demo-staff-user-${suffix}-${pad(index + 1)}`,
        firstName,
        lastName,
        email,
        phone,
        jobTitle: role.replace(/_/g, " "),
      });
      const profile = await ensureProfile(tx, {
        userId: authUser.id,
        firstName,
        lastName,
        email: authUser.email,
        phone,
        jobTitle: role.replace(/_/g, " "),
      });
      const staffMember = await ensureMember(
        tx,
        firm.id,
        authUser.id,
        role === "admin" ? "admin" : "member",
      );

      const [createdStaffMember] = await tx
        .insert(staff)
        .values({
          organizationId: firm.id,
          userId: authUser.id,
          firstName,
          lastName,
          phone,
          jobTitle: role,
          status: index % 11 === 0 ? "on_leave" : "active",
        })
        .returning();

      createdUsers.push(authUser);
      createdProfiles.push(profile);
      createdMembers.push(staffMember);
      createdStaff.push(createdStaffMember);
    }

    const createdStaffCertifications = await tx
      .insert(staffCertifications)
      .values(
        createdStaff.flatMap((staffMember, staffIndex) =>
          range(3).map((offset) => ({
            staffId: staffMember.id,
            certificationCode: pick(certificationRows, staffIndex + offset)
              .code,
            certifiedAt: isoDateFromNow(-365 + staffIndex * 7 + offset),
          })),
        ),
      )
      .returning();

    const paralegalStaff = createdStaff.filter((staffMember) =>
      staffMember.jobTitle?.includes("paralegal"),
    );
    const paralegalProfileValues: NewParalegalProfileRow[] = paralegalStaff
      .slice(0, 15)
      .map((staffMember) => ({
        organizationId: firm.id,
        staffId: staffMember.id,
        type: staffMember.jobTitle === "senior_paralegal" ? "senior" : "junior",
        isCertified: true,
      }));
    const createdParalegalProfiles = await tx
      .insert(paralegalProfiles)
      .values(paralegalProfileValues)
      .returning();

    const teamValues: NewTeamRow[] = range(DEMO_TARGETS.teams).map((index) => ({
      organizationId: firm.id,
      name: `Demo ${pick(practiceAreaRows, index).name} Team ${suffix}-${pad(index + 1)}`,
      leadId: pick(createdStaff, index + 1).id,
      description: `Demo team handling ${pick(practiceAreaRows, index).name.toLowerCase()} workflows.`,
      maxCaseload: 35 + (index % 5) * 5,
      workloadPercentage: 35 + (index % 10) * 5,
      status:
        index % 8 === 0 ? "full" : index % 9 === 0 ? "overloaded" : "available",
      activeCases: 2 + (index % 12),
    }));
    const createdTeams = await tx.insert(teams).values(teamValues).returning();

    const createdTeamMembers = await tx
      .insert(teamMembers)
      .values(
        createdTeams.flatMap((team, teamIndex) =>
          range(4).map((offset) => ({
            teamId: team.id,
            staffId: pick(createdStaff, teamIndex + offset).id,
          })),
        ),
      )
      .returning();

    const companyTypes = [
      "llc",
      "corporation",
      "s_corp",
      "partnership",
      "sole_proprietorship",
      "non_profit",
      "government",
      "other",
    ] as const;
    const industries = [
      "Technology",
      "Healthcare",
      "Manufacturing",
      "Education",
      "Finance",
      "Logistics",
      "Hospitality",
      "Energy",
    ] as const;
    // Create company-type client entities first, then link client_companies
    const companyClientEntities = await tx
      .insert(clients)
      .values(
        range(DEMO_TARGETS.companies).map((index) => ({
          organizationId: firm.id,
          entityType: "company" as const,
          displayName: `Demo ${pick(industries, index)} Company ${suffix}-${pad(index + 1)}`,
          status: (index % 13 === 0 ? "inactive" : "active") as
            | "active"
            | "inactive",
        })),
      )
      .returning();
    const companyValues: NewClientCompanyRow[] = companyClientEntities.map(
      (clientEntity, index) => ({
        organizationId: firm.id,
        clientId: clientEntity.id,
        companyName: clientEntity.displayName,
        companyType: pick(companyTypes, index),
        ein: `9${index}-${String(Date.now()).slice(-7)}`,
        industry: pick(industries, index),
        numberOfEmployees: 15 + index * 23,
        address: `${100 + index} Market Street`,
        city: pick(
          ["Austin", "Dallas", "Houston", "Chicago", "Atlanta"] as const,
          index,
        ),
        state: pick(["TX", "TX", "TX", "IL", "GA"] as const, index),
        zipCode: `${77000 + index}`,
        country: "United States",
        phone: `+1-555-${pad(2100 + index, 4)}`,
        website: `https://demo-company-${pad(index + 1)}.example`,
      }),
    );
    const createdCompanies = await tx
      .insert(clientCompanies)
      .values(companyValues)
      .returning();

    const firstNames = [
      "Sofia",
      "Daniel",
      "Priya",
      "Mateo",
      "Hana",
      "Elena",
      "Victor",
      "Fatima",
      "Luca",
      "Iris",
    ] as const;
    const lastNames = [
      "Martinez",
      "Kim",
      "Raman",
      "Rivera",
      "Nakamura",
      "Petrov",
      "Mensah",
      "Hassan",
      "Bianchi",
      "Novak",
    ] as const;
    const nationalities = [
      "Mexican",
      "South Korean",
      "Indian",
      "Colombian",
      "Japanese",
      "Ukrainian",
      "Ghanaian",
      "Egyptian",
      "Italian",
      "Czech",
    ] as const;

    // Create primary contacts for company-type clients
    await tx.insert(clientContacts).values(
      companyClientEntities.map((clientEntity, index) => ({
        organizationId: firm.id,
        clientId: clientEntity.id,
        role: "primary" as const,
        isPrimary: true,
        firstName: pick(firstNames, index + 2),
        lastName: pick(lastNames, index + 2),
        email: `company.contact.${suffix}.${pad(index + 1)}@${DEMO_EMAIL_DOMAIN}`,
        phone: `+1-555-${pad(2200 + index, 4)}`,
      } satisfies NewClientContactRow)),
    );

    const clientData = range(DEMO_TARGETS.clients).map((index) => {
      const firstName = pick(firstNames, index);
      const lastName = pick(lastNames, index);
      const entityType = pick(
        [
          "individual",
          "individual",
          "individual",
          "individual",
          "trust",
          "estate",
          "other",
        ] as const,
        index,
      );
      const displayName =
        entityType === "individual"
          ? `${firstName} ${lastName}`
          : entityType === "trust"
            ? `${lastName} Family Trust`
            : entityType === "estate"
              ? `Estate of ${firstName} ${lastName}`
              : `${lastName} Holdings`;
      return {
        clientValues: {
          organizationId: firm.id,
          entityType,
          displayName,
          status: (index % 17 === 0
            ? "pending"
            : index % 19 === 0
              ? "inactive"
              : "active") as "active" | "inactive" | "pending",
        } satisfies NewClientRow,
        firstName,
        lastName,
        nationality: pick(nationalities, index),
      };
    });

    const createdClients = await tx
      .insert(clients)
      .values(clientData.map((d) => d.clientValues))
      .returning();

    await tx.insert(clientContacts).values(
      createdClients.map((client, index) => ({
        organizationId: firm.id,
        clientId: client.id,
        role: "primary" as const,
        isPrimary: true,
        firstName: clientData[index].firstName,
        lastName: clientData[index].lastName,
        email: `client.${clientData[index].firstName.toLowerCase()}.${clientData[index].lastName.toLowerCase()}.${suffix}.${pad(index + 1)}@${DEMO_EMAIL_DOMAIN}`,
        phone: `+1-555-${pad(5100 + index, 4)}`,
        nationality: clientData[index].nationality,
      } satisfies NewClientContactRow)),
    );

    const createdCases = await tx
      .insert(cases)
      .values(
        range(DEMO_TARGETS.cases).map((index) => {
          const caseType = pick(caseTypeRows, index);
          const practiceArea = practiceAreaRows.find(
            (area) => area.id === caseType.practiceAreaId,
          )!;
          const client = pick(createdClients, index);
          const assignedStaff = pick(createdStaff, index + 1);
          const team = pick(createdTeams, index);

          return {
            organizationId: firm.id,
            caseNumber: `2026-${caseType.caseNumberPrefix}-DEMO-${suffix}-${pad(index + 1)}`,
            clientId: client.id,
            practiceAreaId: practiceArea.id,
            caseTypeId: caseType.id,
            caseType: caseType.code,
            status: pick(caseStatuses, index),
            priority: pick(casePriorities, index + 1),
            assignmentType:
              index % 5 === 0 ? "external_contractor" : "internal_team",
            teamId: team.id,
            assignedStaffId: assignedStaff.id,
            requiredCertifications: [pick(certificationRows, index).code],
            caseProgress: (index * 7) % 100,
            filingDate: isoDateFromNow(-90 + index),
            estimatedCompletionDate: isoDateFromNow(45 + index),
            nextAppointment: isoDateFromNow(7 + (index % 30)),
            description: `Demo ${practiceArea.name.toLowerCase()} case for ${client.displayName}.`,
            notes: `Generated demo matter ${pad(index + 1)} for workflow coverage.`,
            createdByAdminId: firmAdmin.id,
            createdByStaffId: assignedStaff.id,
          };
        }),
      )
      .returning();

    const contractorValues: NewContractorRow[] = [];
    for (const index of range(DEMO_TARGETS.contractors)) {
      const contractorNumber = pad(index + 1);
      const email = `contractor.${suffix}.${contractorNumber}@${DEMO_EMAIL_DOMAIN}`;
      const authUser = await ensureAuthUser(tx, {
        id: `demo-contractor-user-${suffix}-${contractorNumber}`,
        firstName: "Demo",
        lastName: `Contractor ${contractorNumber}`,
        email,
        phone: `+1-555-${pad(3100 + index, 4)}`,
        jobTitle: "Contractor",
      });

      createdUsers.push(authUser);
      contractorValues.push({
        userId: authUser.id,
        email,
        firstName: "Demo",
        lastName: `Contractor ${contractorNumber}`,
        phoneNumber: `+1-555-${pad(3100 + index, 4)}`,
        desiredHourlyRate: `${85 + index * 5}`,
        consentedToBackgroundCheck: true,
        recognizedDirectoryListingVerificationAccepted: true,
        bio: `Demo contractor profile ${contractorNumber} for marketplace coverage.`,
        availability: pick(
          ["full-time", "part-time", "project-based"] as const,
          index,
        ),
        status: index % 5 === 0 ? "pending" : "active",
      });
    }
    const createdContractors = await tx
      .insert(contractors)
      .values(contractorValues)
      .returning();

    const assignmentValues: NewAssignmentRow[] = range(
      DEMO_TARGETS.assignments,
    ).map((index) => {
      const isExternal = index % 4 === 0;
      return {
        organizationId: firm.id,
        caseId: pick(createdCases, index).id,
        assignmentType: isExternal ? "external_contractor" : "internal_team",
        filingType: pick(filingTypes, index),
        urgencyLevel:
          index % 11 === 0 ? "critical" : index % 5 === 0 ? "urgent" : "normal",
        status: pick(
          ["pending", "active", "completed", "cancelled"] as const,
          index,
        ),
        teamId: isExternal ? undefined : pick(createdTeams, index).id,
        assignedStaffId: isExternal ? undefined : pick(createdStaff, index).id,
        contractorId: isExternal
          ? pick(createdContractors, index).id
          : undefined,
      };
    });
    const createdAssignments = await tx
      .insert(assignments)
      .values(assignmentValues)
      .returning();

    const documentValues: NewDocumentRow[] = range(DEMO_TARGETS.documents).map(
      (index) => {
        const currentCase = pick(createdCases, index);
        const uploader = pick(createdStaff, index);
        return {
          title: `Demo ${pick(documentCategories, index)} document ${pad(index + 1)}.pdf`,
          category: pick(documentCategories, index),
          createdByUserId: uploader.userId,
          status: pick(documentStatuses, index),
        };
      },
    );
    const createdDocuments = await tx
      .insert(documents)
      .values(documentValues)
      .returning();

    const documentVersionValues: NewDocumentVersionRow[] = createdDocuments.map(
      (document, index) => {
        const uploader = pick(createdStaff, index);
        return {
          documentId: document.id,
          filePath: `${firm.id}/documents/${document.id}/v1/demo-${pad(index + 1)}.pdf`,
          fileUrl: `https://${DEMO_EMAIL_DOMAIN}/documents/${suffix}/${pad(index + 1)}.pdf`,
          originalFileName: document.title,
          mimeType: "application/pdf",
          fileSize: 128000 + index * 1536,
          versionNumber: 1,
          uploadedByUserId: uploader.userId,
          scanStatus: index % 3 !== 0 ? "CLEAN" : "SKIPPED",
          scanProvider: "demo",
          scanResult: "Generated demo document",
          scannedAt: index % 3 !== 0 ? timestampFromNow(-index) : undefined,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
        };
      },
    );
    const createdDocumentVersions = await tx
      .insert(documentVersions)
      .values(documentVersionValues)
      .returning();

    for (const [index, document] of createdDocuments.entries()) {
      await tx
        .update(documents)
        .set({ currentVersionId: createdDocumentVersions[index].id })
        .where(eq(documents.id, document.id));
    }

    const documentCaseLinkValues: NewDocumentCaseLinkRow[] =
      createdDocuments.map((document, index) => {
        const currentCase = pick(createdCases, index);
        const uploader = pick(createdStaff, index);
        return {
          documentId: document.id,
          caseId: currentCase.id,
          linkedByUserId: uploader.userId,
        };
      });
    await tx.insert(documentCaseLinks).values(documentCaseLinkValues);

    const documentAccessValues: NewDocumentAccessRow[] = [];
    for (const [index, document] of createdDocuments.entries()) {
      const uploader = pick(createdStaff, index);
      if (!uploader.userId) continue;
      documentAccessValues.push({
        documentId: document.id,
        userId: uploader.userId,
        permission: "ADMIN",
        grantedByUserId: uploader.userId,
      });
    }
    if (documentAccessValues.length) {
      await tx.insert(documentAccess).values(documentAccessValues);
    }

    const documentActivityValues: NewDocumentActivityLogRow[] =
      createdDocuments.map((document, index) => ({
        documentId: document.id,
        actorUserId: pick(createdStaff, index).userId,
        action: "CREATED",
        metadata: {
          source: "demo_seed",
          versionId: createdDocumentVersions[index].id,
          caseId: pick(createdCases, index).id,
        },
      }));
    await tx.insert(documentActivityLogs).values(documentActivityValues);

    const taskValues: NewTaskRow[] = range(DEMO_TARGETS.tasks).map((index) => ({
      organizationId: firm.id,
      title: `Demo task ${pad(index + 1)}`,
      description: `Complete demo workflow task ${pad(index + 1)}.`,
      caseId: pick(createdCases, index).id,
      teamId: pick(createdTeams, index).id,
      assignedToId: pick(createdStaff, index).id,
      assignedById: firmAdmin.id,
      dueDate: isoDateFromNow(1 + (index % 45)),
      priority: pick(casePriorities, index),
      status: pick(taskStatuses, index),
      progress: (index * 9) % 100,
      requiredCertifications: [pick(certificationRows, index).code],
    }));
    const createdTasks = await tx.insert(tasks).values(taskValues).returning();

    const calendarEventValues: NewCalendarEventRow[] = range(
      DEMO_TARGETS.calendarEvents,
    ).map((index) => {
      const start = timestampFromNow(1 + index, 9 + (index % 8));
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      return {
        organizationId: firm.id,
        eventType: pick(eventTypes, index),
        status: index % 13 === 0 ? "completed" : "scheduled",
        title: `Demo calendar event ${pad(index + 1)}`,
        startTime: start,
        endTime: end,
        clientId: pick(createdClients, index).id,
        caseId: pick(createdCases, index).id,
        assignedStaffId: pick(createdStaff, index).id,
        teamId: pick(createdTeams, index).id,
        location: index % 2 === 0 ? "Office" : "Zoom",
        zoomLink:
          index % 2 === 0
            ? undefined
            : `https://zoom.example/${suffix}-${pad(index + 1)}`,
        notes: `Generated demo calendar event ${pad(index + 1)}.`,
        isAutoGenerated: index % 5 === 0,
      };
    });
    const createdCalendarEvents = await tx
      .insert(calendarEvents)
      .values(calendarEventValues)
      .returning();

    const clientRequestValues: NewClientRequestRow[] = range(
      DEMO_TARGETS.clientRequests,
    ).map((index) => {
      const currentCase = pick(createdCases, index);
      return {
        organizationId: firm.id,
        clientId: currentCase.clientId,
        caseId: currentCase.id,
        description: `Upload demo evidence item ${pad(index + 1)}.`,
        requestedAt: isoDateFromNow(-(index % 12)),
        status: index % 3 === 0 ? "fulfilled" : "pending",
      };
    });
    const createdClientRequests = await tx
      .insert(clientRequests)
      .values(clientRequestValues)
      .returning();

    const timeEntryValues: NewTimeEntryRow[] = range(
      DEMO_TARGETS.timeEntries,
    ).map((index) => ({
      organizationId: firm.id,
      staffId: pick(createdStaff, index).id,
      caseId: pick(createdCases, index).id,
      hoursWorked: `${1 + (index % 6)}.${index % 2 === 0 ? "25" : "50"}`,
      entryDate: isoDateFromNow(-(index % 30)),
      description: `Demo time entry ${pad(index + 1)}.`,
    }));
    const createdTimeEntries = await tx
      .insert(timeEntries)
      .values(timeEntryValues)
      .returning();

    const leaveRequestValues: NewLeaveRequestRow[] = range(
      DEMO_TARGETS.leaveRequests,
    ).map((index) => ({
      organizationId: firm.id,
      staffId: pick(createdStaff, index).id,
      type: pick(leaveTypes, index),
      startDate: isoDateFromNow(10 + index),
      endDate: isoDateFromNow(11 + index),
      status: pick(leaveStatuses, index),
      reason: `Demo leave request ${pad(index + 1)}.`,
    }));
    const createdLeaveRequests = await tx
      .insert(leaveRequests)
      .values(leaveRequestValues)
      .returning();

    const createdLeads: (typeof leads.$inferSelect)[] = [];
    const createdConflictChecks: (typeof conflictChecks.$inferSelect)[] = [];
    const createdConsultations: (typeof consultations.$inferSelect)[] = [];
    const createdFeeAgreements: (typeof feeAgreements.$inferSelect)[] = [];

    const conflictCheckStages = new Set([
      "conflict_check",
      "questionnaire",
      "consultation",
      "fee_agreement",
      "case_opening",
    ]);
    const consultationStages = new Set([
      "consultation",
      "fee_agreement",
      "case_opening",
    ]);
    const feeAgreementStages = new Set(["fee_agreement", "case_opening"]);

    for (const index of range(DEMO_TARGETS.leads)) {
      const [firstName, lastName] = pick(DEMO_LEAD_NAMES, index);
      const pipelineStage = pick(leadPipelineStages, index);
      const caseType = pick(caseTypeRows, index + 3);
      const practiceArea = practiceAreaRows.find(
        (a) => a.id === caseType.practiceAreaId,
      )!;
      const assignedStaff = pick(createdStaff, index + 2);
      const email = `lead.${firstName.toLowerCase()}.${lastName.toLowerCase()}.${suffix}@${DEMO_EMAIL_DOMAIN}`;

      const [lead] = await tx
        .insert(leads)
        .values({
          organizationId: firm.id,
          name: `${firstName} ${lastName}`,
          email,
          phone: `+1-555-${pad(4100 + index, 4)}`,
          entityType: "individual",
          practiceAreaId: practiceArea.id,
          caseTypeId: caseType.id,
          source: pick(leadSources, index),
          situationSummary: `Demo intake for ${practiceArea.name.toLowerCase()} matters.`,
          status: pick(["new", "new", "reviewed", "archived"] as const, index),
          pipelineStage,
          assignedStaffId: assignedStaff.id,
        } satisfies NewLeadRow)
        .returning();

      createdLeads.push(lead);

      if (conflictCheckStages.has(pipelineStage)) {
        const [cc] = await tx
          .insert(conflictChecks)
          .values({
            organizationId: firm.id,
            leadId: lead.id,
            status: pick(conflictCheckStatuses, index),
            checkedById: assignedStaff.id,
            checkedAt: timestampFromNow(-7 + (index % 5)),
          } satisfies NewConflictCheckRow)
          .returning();
        createdConflictChecks.push(cc);
        await tx
          .update(leads)
          .set({ conflictCheckId: cc.id })
          .where(eq(leads.id, lead.id));
      }

      if (consultationStages.has(pipelineStage)) {
        const status = pick(consultationStatuses, index);
        const [consult] = await tx
          .insert(consultations)
          .values({
            organizationId: firm.id,
            leadId: lead.id,
            scheduledAt: timestampFromNow(3 + (index % 14)),
            duration: pick([30, 45, 60] as const, index),
            mode: pick(["video", "in_person"] as const, index),
            leadAttorneyId: assignedStaff.id,
            status,
            outcome:
              status === "completed"
                ? pick(consultationOutcomes, index)
                : undefined,
          } satisfies NewConsultationRow)
          .returning();
        createdConsultations.push(consult);
        await tx
          .update(leads)
          .set({ consultationId: consult.id })
          .where(eq(leads.id, lead.id));
      }

      if (feeAgreementStages.has(pipelineStage)) {
        const [fa] = await tx
          .insert(feeAgreements)
          .values({
            organizationId: firm.id,
            leadId: lead.id,
            practiceAreaId: practiceArea.id,
            caseTypeId: caseType.id,
            agreementType: "standard_retainer",
            generatedFrom: "manual",
            status: pick(feeAgreementStatuses, index),
          } satisfies NewFeeAgreementRow)
          .returning();
        createdFeeAgreements.push(fa);
        await tx
          .update(leads)
          .set({ feeAgreementId: fa.id })
          .where(eq(leads.id, lead.id));
      }
    }

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
      .values(
        range(DEMO_TARGETS.aiErrorFlags).map((index) => {
          const currentCase = pick(createdCases, index);
          const document = pick(createdDocuments, index);
          const isResolved = pick(errorStatuses, index) === "resolved";

          return {
            organizationId: firm.id,
            clientId: currentCase.clientId,
            caseId: currentCase.id,
            documentId: document.id,
            title: `Demo AI review flag ${pad(index + 1)}`,
            description: `Generated AI validation flag ${pad(index + 1)} for demo review queues.`,
            severity: pick(errorSeverities, index),
            status: pick(errorStatuses, index),
            affectedField: pick(
              ["name", "date_of_birth", "address", "signature"] as const,
              index,
            ),
            documentRef: document.title,
            resolvedById: isResolved ? firmAdmin.id : undefined,
            resolvedAt: isResolved ? timestampFromNow(-index) : undefined,
          };
        }),
      )
      .returning();

    return {
      firm: {
        id: firm.id,
        firmName: firm.firmName,
      },
      practiceAreaCount: practiceAreaRows.length,
      caseTypeCount: caseTypeRows.length,
      subscriptionCount: subscriptionRows.length,
      firmPracticeAreaCount: firmPracticeAreaRows.length,
      adminId: firmAdmin.id,
      userCount: createdUsers.length,
      memberCount: createdMembers.length,
      profileCount: createdProfiles.length,
      staffCount: createdStaff.length,
      certificationCount: certificationRows.length,
      staffCertificationCount: createdStaffCertifications.length,
      paralegalProfileCount: createdParalegalProfiles.length,
      teamCount: createdTeams.length,
      teamMemberCount: createdTeamMembers.length,
      companyCount: createdCompanies.length,
      clientCount: createdClients.length,
      caseCount: createdCases.length,
      leadCount: createdLeads.length,
      conflictCheckCount: createdConflictChecks.length,
      consultationCount: createdConsultations.length,
      feeAgreementCount: createdFeeAgreements.length,
      contractorCount: createdContractors.length,
      assignmentCount: createdAssignments.length,
      documentCount: createdDocuments.length,
      taskCount: createdTasks.length,
      calendarEventCount: createdCalendarEvents.length,
      clientRequestCount: createdClientRequests.length,
      timeEntryCount: createdTimeEntries.length,
      leaveRequestCount: createdLeaveRequests.length,
      aiErrorFlagCount: createdAiErrorFlags.length,
    } satisfies DemoSeedResult;
  });

  printDemoSeedResult(result);
};

type DemoDropResult = {
  firm: Pick<FirmRow, "id" | "firmName">;
  deleted: Record<string, number>;
};

const printDemoDropResult = (result: DemoDropResult) => {
  console.table([{ firm: result.firm.firmName, ...result.deleted }]);
};

const dropDemoData = async (organizationId?: string) => {
  assertDevelopment();

  const firm = await resolveFirm(organizationId);
  if (!firm) return;

  note(
    [
      `This will delete tenant-scoped demo data for ${firm.firmName}.`,
      "The organization row and global reference data such as practice areas, case types, and certifications are kept.",
    ].join("\n"),
    "Development-only demo data drop",
  );

  const shouldDrop = abortIfCancelled(
    await confirm({
      message: "Delete demo data for this organization?",
      initialValue: false,
    }),
  );

  if (!shouldDrop) {
    note("Nothing deleted.");
    return;
  }

  const result = await db.transaction(async (tx) => {
    const orgStaff = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.organizationId, firm.id));
    const orgTeams = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.organizationId, firm.id));
    const demoUsers = await tx
      .select({ id: user.id })
      .from(user)
      .innerJoin(member, eq(member.userId, user.id))
      .where(
        and(
          eq(member.organizationId, firm.id),
          ilike(user.email, `%@${DEMO_EMAIL_DOMAIN}`),
        ),
      );
    const orgDocuments = await tx
      .select({ id: documents.id })
      .from(documentCaseLinks)
      .innerJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .innerJoin(documents, eq(documents.id, documentCaseLinks.documentId))
      .where(eq(cases.organizationId, firm.id));
    const orgDocumentRequests = await tx
      .select({ id: documentRequests.id })
      .from(documentRequests)
      .innerJoin(user, eq(user.id, documentRequests.requestedByUserId))
      .innerJoin(member, eq(member.userId, user.id))
      .where(eq(member.organizationId, firm.id));

    const staffIds = orgStaff.map((row) => row.id);
    const teamIds = orgTeams.map((row) => row.id);
    const demoUserIds = demoUsers.map((row) => row.id);
    const documentIds = orgDocuments.map((row) => row.id);
    const documentRequestIds = orgDocumentRequests.map((row) => row.id);

    const deleted: Record<string, number> = {};
    const record = (key: string, rows: unknown[]) => {
      deleted[key] = rows.length;
    };

    record(
      "aiErrorFlags",
      await tx
        .delete(aiErrorFlags)
        .where(eq(aiErrorFlags.organizationId, firm.id))
        .returning(),
    );

    if (documentRequestIds.length || documentIds.length) {
      const externalSubmissionConditions = [];
      if (documentRequestIds.length) {
        externalSubmissionConditions.push(
          inArray(externalSubmissions.requestId, documentRequestIds),
        );
      }
      if (documentIds.length) {
        externalSubmissionConditions.push(
          inArray(externalSubmissions.documentId, documentIds),
        );
      }

      record(
        "externalSubmissions",
        await tx
          .delete(externalSubmissions)
          .where(or(...externalSubmissionConditions))
          .returning(),
      );
    } else {
      deleted.externalSubmissions = 0;
    }

    if (documentIds.length) {
      record(
        "documentActivityLogs",
        await tx
          .delete(documentActivityLogs)
          .where(inArray(documentActivityLogs.documentId, documentIds))
          .returning(),
      );
      record(
        "documentAccess",
        await tx
          .delete(documentAccess)
          .where(inArray(documentAccess.documentId, documentIds))
          .returning(),
      );
      record(
        "documentCaseLinks",
        await tx
          .delete(documentCaseLinks)
          .where(inArray(documentCaseLinks.documentId, documentIds))
          .returning(),
      );
      record(
        "documentVersions",
        await tx
          .delete(documentVersions)
          .where(inArray(documentVersions.documentId, documentIds))
          .returning(),
      );
    } else {
      deleted.documentActivityLogs = 0;
      deleted.documentAccess = 0;
      deleted.documentCaseLinks = 0;
      deleted.documentVersions = 0;
    }

    if (documentRequestIds.length) {
      record(
        "documentRequests",
        await tx
          .delete(documentRequests)
          .where(inArray(documentRequests.id, documentRequestIds))
          .returning(),
      );
    } else {
      deleted.documentRequests = 0;
    }

    record(
      "documents",
      documentIds.length
        ? await tx
            .delete(documents)
            .where(inArray(documents.id, documentIds))
            .returning()
        : [],
    );
    record(
      "tasks",
      await tx
        .delete(tasks)
        .where(eq(tasks.organizationId, firm.id))
        .returning(),
    );
    record(
      "calendarEvents",
      await tx
        .delete(calendarEvents)
        .where(eq(calendarEvents.organizationId, firm.id))
        .returning(),
    );
    record(
      "clientRequests",
      await tx
        .delete(clientRequests)
        .where(eq(clientRequests.organizationId, firm.id))
        .returning(),
    );
    record(
      "timeEntries",
      await tx
        .delete(timeEntries)
        .where(eq(timeEntries.organizationId, firm.id))
        .returning(),
    );
    record(
      "assignments",
      await tx
        .delete(assignments)
        .where(eq(assignments.organizationId, firm.id))
        .returning(),
    );
    record(
      "leaveRequests",
      await tx
        .delete(leaveRequests)
        .where(eq(leaveRequests.organizationId, firm.id))
        .returning(),
    );
    record(
      "paralegalProfiles",
      await tx
        .delete(paralegalProfiles)
        .where(eq(paralegalProfiles.organizationId, firm.id))
        .returning(),
    );

    if (staffIds.length) {
      record(
        "staffCertifications",
        await tx
          .delete(staffCertifications)
          .where(inArray(staffCertifications.staffId, staffIds))
          .returning(),
      );
    } else {
      deleted.staffCertifications = 0;
    }

    if (teamIds.length) {
      record(
        "teamMembers",
        await tx
          .delete(teamMembers)
          .where(inArray(teamMembers.teamId, teamIds))
          .returning(),
      );
    } else {
      deleted.teamMembers = 0;
    }

    record(
      "cases",
      await tx
        .delete(cases)
        .where(eq(cases.organizationId, firm.id))
        .returning(),
    );
    record(
      "clientCompanies",
      await tx
        .delete(clientCompanies)
        .where(eq(clientCompanies.organizationId, firm.id))
        .returning(),
    );
    record(
      "clientContacts",
      await tx
        .delete(clientContacts)
        .where(eq(clientContacts.organizationId, firm.id))
        .returning(),
    );
    record(
      "clients",
      await tx
        .delete(clients)
        .where(eq(clients.organizationId, firm.id))
        .returning(),
    );
    record(
      "contractors",
      await tx
        .delete(contractors)
        .where(ilike(contractors.email, `contractor.%@${DEMO_EMAIL_DOMAIN}`))
        .returning(),
    );
    record(
      "teams",
      await tx
        .delete(teams)
        .where(eq(teams.organizationId, firm.id))
        .returning(),
    );
    record(
      "staff",
      await tx
        .delete(staff)
        .where(eq(staff.organizationId, firm.id))
        .returning(),
    );
    record(
      "firmPracticeAreas",
      await tx
        .delete(firmPracticeAreas)
        .where(eq(firmPracticeAreas.organizationId, firm.id))
        .returning(),
    );
    record(
      "subscriptions",
      await tx
        .delete(subscriptions)
        .where(eq(subscriptions.organizationId, firm.id))
        .returning(),
    );
    record(
      "aiSystemConfig",
      await tx
        .delete(aiSystemConfig)
        .where(eq(aiSystemConfig.organizationId, firm.id))
        .returning(),
    );
    record(
      "admins",
      await tx
        .delete(admins)
        .where(
          and(
            eq(admins.organizationId, firm.id),
            ilike(admins.email, `%@${DEMO_EMAIL_DOMAIN}`),
          ),
        )
        .returning(),
    );

    if (demoUserIds.length) {
      record(
        "profiles",
        await tx
          .delete(profiles)
          .where(inArray(profiles.userId, demoUserIds))
          .returning(),
      );
      record(
        "members",
        await tx
          .delete(member)
          .where(inArray(member.userId, demoUserIds))
          .returning(),
      );
      record(
        "users",
        await tx.delete(user).where(inArray(user.id, demoUserIds)).returning(),
      );
    } else {
      deleted.profiles = 0;
      deleted.members = 0;
      deleted.users = 0;
    }

    return {
      firm: {
        id: firm.id,
        firmName: firm.firmName,
      },
      deleted,
    } satisfies DemoDropResult;
  });

  printDemoDropResult(result);
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
              return normalizeName(value)
                ? undefined
                : "Enter a practice area name.";
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
  if (env.NODE_ENV !== "development") {
    note(
      "Deleting practice areas is only available in development.",
      "Forbidden",
    );
    return;
  }

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
    [
      "WARNING: This action is irreversible.",
      "",
      "The following practice areas and ALL associated data will be permanently deleted:",
      "  - Subcategories and case types",
      "  - Leads and their conflict checks, consultations, and fee agreements",
      "  - Cases and their tasks, assignments, time entries, calendar events, and documents",
      "  - Questionnaire templates, sends, and responses",
      "  - Workflow templates and steps",
      "  - Subscriptions and firm practice area links",
      "",
      ...areas.map((area) => `  · ${area.name} (${area.id})`),
    ].join("\n"),
    "Destructive action",
  );

  const shouldDelete = abortIfCancelled(
    await confirm({
      message: `Permanently delete ${areas.length} practice area${areas.length === 1 ? "" : "s"} and all associated data?`,
      initialValue: false,
    }),
  );

  if (!shouldDelete) {
    note("Nothing deleted.");
    return;
  }

  const areaIds = areas.map((a) => a.id);

  const deleted = await db.transaction(async (tx) => {
    // ─── Gather dependent IDs ───────────────────────────────────────────────
    const subcategoryRows = await tx
      .select({ id: practiceAreaSubcategories.id })
      .from(practiceAreaSubcategories)
      .where(inArray(practiceAreaSubcategories.practiceAreaId, areaIds));
    const subcategoryIds = subcategoryRows.map((r) => r.id);

    const caseTypeRows = subcategoryIds.length
      ? await tx
          .select({ id: practiceAreaCaseTypes.id })
          .from(practiceAreaCaseTypes)
          .where(inArray(practiceAreaCaseTypes.subcategoryId, subcategoryIds))
      : [];
    const caseTypeIds = caseTypeRows.map((r) => r.id);

    const caseRows = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(inArray(cases.practiceAreaId, areaIds));
    const caseIds = caseRows.map((r) => r.id);

    const leadRows = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(inArray(leads.practiceAreaId, areaIds));
    const leadIds = leadRows.map((r) => r.id);

    const ctqRows = caseTypeIds.length
      ? await tx
          .select({ id: caseTypeQuestionnaires.id })
          .from(caseTypeQuestionnaires)
          .where(inArray(caseTypeQuestionnaires.caseTypeId, caseTypeIds))
      : [];
    const ctqIds = ctqRows.map((r) => r.id);

    const sendConditions = [
      ...(caseTypeIds.length
        ? [inArray(questionnaireSends.caseTypeId, caseTypeIds)]
        : []),
      ...(leadIds.length ? [inArray(questionnaireSends.leadId, leadIds)] : []),
      ...(caseIds.length ? [inArray(questionnaireSends.caseId, caseIds)] : []),
    ];
    const sendRows = sendConditions.length
      ? await tx
          .select({ id: questionnaireSends.id })
          .from(questionnaireSends)
          .where(or(...sendConditions))
      : [];
    const sendIds = sendRows.map((r) => r.id);

    const responseRows = sendIds.length
      ? await tx
          .select({ id: questionnaireResponses.id })
          .from(questionnaireResponses)
          .where(inArray(questionnaireResponses.questionnaireSendId, sendIds))
      : [];
    const responseIds = responseRows.map((r) => r.id);

    const templateRows = caseTypeIds.length
      ? await tx
          .select({ id: workflowTemplates.id })
          .from(workflowTemplates)
          .where(inArray(workflowTemplates.caseTypeId, caseTypeIds))
      : [];
    const templateIds = templateRows.map((r) => r.id);

    const templateStepRows = templateIds.length
      ? await tx
          .select({ id: workflowTemplateSteps.id })
          .from(workflowTemplateSteps)
          .where(inArray(workflowTemplateSteps.templateId, templateIds))
      : [];
    const templateStepIds = templateStepRows.map((r) => r.id);

    const docRequestRows = caseIds.length
      ? await tx
          .select({ id: documentRequests.id })
          .from(documentRequests)
          .where(inArray(documentRequests.caseId, caseIds))
      : [];
    const docRequestIds = docRequestRows.map((r) => r.id);

    // ─── Delete in reverse dependency order ─────────────────────────────────

    if (responseIds.length) {
      await tx
        .delete(questionnaireAnswers)
        .where(inArray(questionnaireAnswers.responseId, responseIds));
      await tx
        .delete(questionnaireResponseFiles)
        .where(inArray(questionnaireResponseFiles.responseId, responseIds));
      await tx
        .delete(questionnaireResponses)
        .where(inArray(questionnaireResponses.id, responseIds));
    }
    if (sendIds.length) {
      await tx
        .delete(questionnaireSends)
        .where(inArray(questionnaireSends.id, sendIds));
    }
    if (caseTypeIds.length) {
      await tx
        .delete(firmQuestionnaireLogicRules)
        .where(inArray(firmQuestionnaireLogicRules.caseTypeId, caseTypeIds));
      await tx
        .delete(firmQuestionnaireQuestions)
        .where(inArray(firmQuestionnaireQuestions.caseTypeId, caseTypeIds));
      await tx
        .delete(firmQuestionnaireSections)
        .where(inArray(firmQuestionnaireSections.caseTypeId, caseTypeIds));
    }
    if (ctqIds.length) {
      await tx
        .delete(caseTypeQuestionnaireLogicRules)
        .where(
          inArray(caseTypeQuestionnaireLogicRules.questionnaireId, ctqIds),
        );
      await tx
        .delete(caseTypeQuestionnaireQuestions)
        .where(inArray(caseTypeQuestionnaireQuestions.questionnaireId, ctqIds));
      await tx
        .delete(caseTypeQuestionnaireSections)
        .where(inArray(caseTypeQuestionnaireSections.questionnaireId, ctqIds));
      await tx
        .delete(caseTypeQuestionnaires)
        .where(inArray(caseTypeQuestionnaires.id, ctqIds));
    }
    const caseStepConditions = [
      ...(caseIds.length ? [inArray(caseWorkflowSteps.caseId, caseIds)] : []),
      ...(templateStepIds.length
        ? [inArray(caseWorkflowSteps.templateStepId, templateStepIds)]
        : []),
    ];
    if (caseStepConditions.length) {
      await tx.delete(caseWorkflowSteps).where(or(...caseStepConditions));
    }
    if (templateStepIds.length) {
      await tx
        .delete(workflowTemplateSteps)
        .where(inArray(workflowTemplateSteps.id, templateStepIds));
    }
    if (templateIds.length) {
      await tx
        .delete(workflowTemplates)
        .where(inArray(workflowTemplates.id, templateIds));
    }
    if (caseIds.length) {
      await tx
        .delete(aiErrorFlags)
        .where(inArray(aiErrorFlags.caseId, caseIds));
      await tx
        .delete(adverseParties)
        .where(inArray(adverseParties.caseId, caseIds));
      await tx.delete(assignments).where(inArray(assignments.caseId, caseIds));
      await tx.delete(tasks).where(inArray(tasks.caseId, caseIds));
      await tx.delete(timeEntries).where(inArray(timeEntries.caseId, caseIds));
      await tx
        .delete(calendarEvents)
        .where(inArray(calendarEvents.caseId, caseIds));
      await tx
        .delete(clientRequests)
        .where(inArray(clientRequests.caseId, caseIds));
      await tx
        .delete(documentCaseLinks)
        .where(inArray(documentCaseLinks.caseId, caseIds));
      if (docRequestIds.length) {
        await tx
          .delete(externalSubmissions)
          .where(inArray(externalSubmissions.requestId, docRequestIds));
        await tx
          .delete(documentRequests)
          .where(inArray(documentRequests.id, docRequestIds));
      }
      await tx.delete(cases).where(inArray(cases.id, caseIds));
    }
    if (leadIds.length) {
      await tx
        .delete(conflictChecks)
        .where(inArray(conflictChecks.leadId, leadIds));
      await tx
        .delete(consultations)
        .where(inArray(consultations.leadId, leadIds));
      await tx
        .delete(feeAgreements)
        .where(inArray(feeAgreements.leadId, leadIds));
      await tx
        .delete(clientContacts)
        .where(inArray(clientContacts.leadId, leadIds));
      await tx.delete(leads).where(inArray(leads.id, leadIds));
    }
    await tx
      .delete(subscriptions)
      .where(inArray(subscriptions.practiceAreaId, areaIds));

    // DB CASCADE handles: firm_practice_areas, subcategories → case_types → contractors
    return tx
      .delete(practiceAreas)
      .where(inArray(practiceAreas.id, areaIds))
      .returning();
  });

  printPracticeAreas(deleted);
};

const browseCases = async () => {
  // Step 1 – firm
  const firm = await resolveFirm();
  if (!firm) return;

  // Step 2 – practice area (only areas that have cases for this firm)
  const firmPracticeAreaRows = await db
    .selectDistinct({ id: practiceAreas.id, name: practiceAreas.name })
    .from(cases)
    .innerJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .where(eq(cases.organizationId, firm.id))
    .orderBy(asc(practiceAreas.name));

  if (!firmPracticeAreaRows.length) {
    note(`No cases found for ${firm.firmName}.`);
    return;
  }

  const selectedPracticeAreaId = abortIfCancelled(
    await select({
      message: "Select a practice area",
      options: firmPracticeAreaRows.map((pa) => ({
        value: pa.id,
        label: pa.name,
      })),
    }),
  ) as string;

  const selectedPracticeArea = firmPracticeAreaRows.find(
    (pa) => pa.id === selectedPracticeAreaId,
  )!;

  // Step 3 – case type (only types that have cases for this firm + practice area)
  const firmCaseTypeRows = await db
    .selectDistinct({
      id: practiceAreaCaseTypes.id,
      name: practiceAreaCaseTypes.name,
      code: practiceAreaCaseTypes.code,
    })
    .from(cases)
    .innerJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .where(
      and(
        eq(cases.organizationId, firm.id),
        eq(cases.practiceAreaId, selectedPracticeAreaId),
      ),
    )
    .orderBy(asc(practiceAreaCaseTypes.name));

  if (!firmCaseTypeRows.length) {
    note(`No case types found for ${selectedPracticeArea.name}.`);
    return;
  }

  const selectedCaseTypeId = abortIfCancelled(
    await select({
      message: "Select a case type",
      options: firmCaseTypeRows.map((ct) => ({
        value: ct.id,
        label: ct.name,
        hint: ct.code,
      })),
    }),
  ) as string;

  const selectedCaseType = firmCaseTypeRows.find(
    (ct) => ct.id === selectedCaseTypeId,
  )!;

  // Step 4 – case
  const caseListRows = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      clientName: clients.displayName,
      status: cases.status,
    })
    .from(cases)
    .innerJoin(clients, eq(clients.id, cases.clientId))
    .where(
      and(
        eq(cases.organizationId, firm.id),
        eq(cases.practiceAreaId, selectedPracticeAreaId),
        eq(cases.caseTypeId, selectedCaseTypeId),
      ),
    )
    .orderBy(desc(cases.createdAt));

  if (!caseListRows.length) {
    note(`No cases found for ${selectedCaseType.name}.`);
    return;
  }

  const selectedCaseId = abortIfCancelled(
    await select({
      message: "Select a case",
      options: caseListRows.map((c) => ({
        value: c.id,
        label: c.caseNumber,
        hint: `${c.clientName} — ${c.status}`,
      })),
    }),
  ) as string;

  // Step 5 – fetch expanded details
  const [detail] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      status: cases.status,
      priority: cases.priority,
      caseProgress: cases.caseProgress,
      assignmentType: cases.assignmentType,
      filingDate: cases.filingDate,
      estimatedCompletionDate: cases.estimatedCompletionDate,
      nextAppointment: cases.nextAppointment,
      description: cases.description,
      notes: cases.notes,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
      firmName: organizations.name,
      practiceAreaName: practiceAreas.name,
      caseTypeName: practiceAreaCaseTypes.name,
      clientName: clients.displayName,
      assignedStaffFirstName: staff.firstName,
      assignedStaffLastName: staff.lastName,
      teamName: teams.name,
    })
    .from(cases)
    .innerJoin(organizations, eq(organizations.id, cases.organizationId))
    .innerJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .innerJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .innerJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .leftJoin(teams, eq(teams.id, cases.teamId))
    .where(eq(cases.id, selectedCaseId))
    .limit(1);

  if (!detail) {
    note("Case not found.");
    return;
  }

  const assignedStaff =
    detail.assignedStaffFirstName && detail.assignedStaffLastName
      ? `${detail.assignedStaffFirstName} ${detail.assignedStaffLastName}`
      : "—";

  note(
    [
      `Case Number:          ${detail.caseNumber}`,
      `Firm:                 ${detail.firmName}`,
      `Practice Area:        ${detail.practiceAreaName}`,
      `Case Type:            ${detail.caseTypeName}`,
      `Client:               ${detail.clientName}`,
      `Status:               ${detail.status}`,
      `Priority:             ${detail.priority}`,
      `Progress:             ${detail.caseProgress}%`,
      `Assignment Type:      ${detail.assignmentType}`,
      `Assigned Staff:       ${assignedStaff}`,
      `Team:                 ${detail.teamName ?? "—"}`,
      `Filing Date:          ${detail.filingDate}`,
      `Est. Completion:      ${detail.estimatedCompletionDate ?? "—"}`,
      `Next Appointment:     ${detail.nextAppointment ?? "—"}`,
      `Description:          ${detail.description}`,
      `Notes:                ${detail.notes ?? "—"}`,
      `Created:              ${detail.createdAt.toISOString()}`,
      `Updated:              ${detail.updatedAt.toISOString()}`,
    ].join("\n"),
    "Case Details",
  );
};

const waitForEnter = async () => {
  abortIfCancelled(
    await text({
      message: "Press Enter to return to the menu...",
      defaultValue: "",
    }),
  );
};

const runInteractive = async () => {
  intro("Oravanti CLI");

  while (true) {
    const action = await select({
      message: "What do you want to do?",
      options: [
        { value: "list", label: "Fetch practice areas" },
        { value: "seed-taxonomy", label: "Seed practice area taxonomy" },
        { value: "edit", label: "Edit a practice area" },
        { value: "delete", label: "Delete practice areas" },
        { value: "case-types-list", label: "Fetch case types" },
        { value: "case-types-create", label: "Create case types" },
        {
          value: "case-types-defaults",
          label: "Create Immigration case types",
        },
        { value: "case-types-edit", label: "Edit a case type" },
        { value: "case-types-delete", label: "Delete case types" },
        {
          value: "seed-questionnaires",
          label: "Seed system questionnaires (one per case type)",
        },
        { value: "demo-data", label: "Seed demo data for an organization" },
        {
          value: "demo-data-drop",
          label: "Drop demo data for an organization",
        },
        {
          value: "browse-cases",
          label: "Browse cases (firm → practice area → case type → case)",
        },
        { value: "exit", label: "Exit" },
      ],
    });

    if (isCancel(action) || action === "exit") {
      outro("Goodbye.");
      return;
    }

    try {
      if (action === "list") {
        printPracticeAreas(await getPracticeAreas());
      }

      if (action === "seed-taxonomy") {
        await seedPracticeAreaTaxonomy();
      }

      if (action === "edit") {
        await editPracticeArea();
      }

      if (action === "delete") {
        await deletePracticeAreas([]);
      }

      if (action === "case-types-list") {
        const resolved = await resolveSubcategory();
        if (resolved)
          printCaseTypes(await getCaseTypes(resolved.subcategory.id));
      }

      if (action === "case-types-create") {
        const resolved = await resolveSubcategory();
        if (resolved) {
          await createCaseTypes(
            resolved.area.id,
            resolved.subcategory.id,
            await promptForCaseTypeDefinitions(),
          );
        }
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

      if (action === "seed-questionnaires") {
        await seedSystemQuestionnaires();
      }

      if (action === "demo-data") {
        await seedDemoData();
      }

      if (action === "demo-data-drop") {
        await dropDemoData();
      }

      if (action === "browse-cases") {
        await browseCases();
      }

      await waitForEnter();
    } catch (err) {
      // Cancellation within a sub-action: return to the main menu
      if (err instanceof Error && err.message === "cancelled") {
        process.exitCode = 0;
        continue;
      }
      throw err;
    }
  }
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
  .name("cli")
  .description("Manage Oravanti admin and development utilities")
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
  .command("seed-taxonomy")
  .description("Seed the full practice area taxonomy from the bundled catalog")
  .action(seedPracticeAreaTaxonomy);

program
  .command("seed-questionnaires")
  .description("Seed system questionnaires (one per case type, idempotent)")
  .action(seedSystemQuestionnaires);

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
  .description("Manage case types for a practice area subcategory");

caseTypesCommand
  .command("list")
  .description("Fetch case types for a practice area subcategory")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[subcategoryId]", "Subcategory id")
  .action(async (practiceAreaId?: string, subcategoryId?: string) => {
    const resolved = await resolveSubcategory(practiceAreaId, subcategoryId);
    if (resolved) printCaseTypes(await getCaseTypes(resolved.subcategory.id));
  });

caseTypesCommand
  .command("add")
  .description("Add one or more case types as code|Name|PREFIX|jurisdiction")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[subcategoryId]", "Subcategory id")
  .argument("[definitions...]", "Case type definitions")
  .action(
    async (
      practiceAreaId?: string,
      subcategoryId?: string,
      definitions: string[] = [],
    ) => {
      const definitionsToCreate = definitions.length
        ? definitions
        : await promptForCaseTypeDefinitions();

      await createCaseTypes(practiceAreaId, subcategoryId, definitionsToCreate);
    },
  );

caseTypesCommand
  .command("add-immigration-defaults")
  .description(
    "Add the existing immigration case types to Immigration or a practice area id",
  )
  .argument("[practiceAreaId]", "Practice area id")
  .action(createDefaultImmigrationCaseTypes);

caseTypesCommand
  .command("edit")
  .description("Edit a case type")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[subcategoryId]", "Subcategory id")
  .argument("[caseTypeId]", "Case type id")
  .option("-c, --code <code>", "Case type code")
  .option("-n, --name <name>", "Case type name")
  .option("-p, --prefix <prefix>", "Case number prefix")
  .option("-j, --jurisdiction <jurisdiction>", "Case type jurisdiction")
  .action(editCaseType);

caseTypesCommand
  .command("delete")
  .description("Delete one or more case types with confirmation")
  .argument("[practiceAreaId]", "Practice area id")
  .argument("[subcategoryId]", "Subcategory id")
  .argument("[ids...]", "Case type ids")
  .action(deleteCaseTypes);

const demoDataCommand = program
  .command("demo-data")
  .description("Development-only demo data tools");

demoDataCommand
  .command("seed")
  .description("Select an organization and populate linked demo data")
  .argument("[organizationId]", "Organization id")
  .action(seedDemoData);

demoDataCommand
  .command("drop")
  .description("Select an organization and delete tenant-scoped demo data")
  .argument("[organizationId]", "Organization id")
  .action(dropDemoData);

const casesCommand = program
  .command("cases")
  .description("Browse and inspect cases");

casesCommand
  .command("browse")
  .description(
    "Interactively browse cases by firm, practice area, and case type",
  )
  .action(browseCases);

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
