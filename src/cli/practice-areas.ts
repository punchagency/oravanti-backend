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
import { asc, eq, inArray, ilike } from "drizzle-orm";
import { closeDb, db } from "../db/client";
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

type PracticeAreaRow = typeof practiceAreas.$inferSelect;

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
