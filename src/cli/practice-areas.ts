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
import { and, asc, eq, inArray, ilike } from "drizzle-orm";
import { closeDb, db } from "../db/client";
import { practiceAreaCaseTypes } from "../db/schema/practice-area-case-types";
import { practiceAreas } from "../db/schema/practice-areas";

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

type CaseTypeInput = {
  code: string;
  name: string;
  caseNumberPrefix: string;
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
