import { eq, inArray, sql } from "drizzle-orm";

import { GlobalImmigrationSchema } from "../../lib/schema/global-schema";
import { flattenSchema, type SchemaNode } from "../../lib/schema/nodes";
import { formLocalPrefix } from "../../modules/workflow/pdf-field-naming";
import { pathOf } from "../../modules/workflow/repeat-group";
import { db } from "../client";
import { formDefinitions, formFieldDefinitions } from "../schema/form-fields";
import { questionnaireQuestions } from "../schema/questionnaires";
import { schemaNodes } from "../schema/schema-nodes";

/**
 * Load `global-schema.ts` into `schema_nodes`.
 *
 * Idempotent, and additive by default: a node the declaration no longer names
 * is *reported*, not deleted, because something may already be bound to it —
 * see `wouldOrphan` below. Pass `prune` once the report is empty.
 */
export async function seedSchemaNodes({ prune = false } = {}) {
  const declared = flattenSchema(GlobalImmigrationSchema);
  const existing = await db.select().from(schemaNodes);
  const byPath = new Map(existing.map((row) => [row.path, row]));

  const added: string[] = [];
  const changed: string[] = [];

  for (const node of declared) {
    const row = byPath.get(node.path);
    const values = {
      label: node.label,
      category: node.category,
      dataType: node.dataType,
      isRepeating: node.isRepeating,
      options: node.options ?? [],
      orderIndex: node.orderIndex,
    };

    if (!row) {
      await db.insert(schemaNodes).values({ path: node.path, ...values });
      added.push(node.path);
      continue;
    }

    const diff = describeChange(row, node);
    if (!diff) continue;

    await db
      .update(schemaNodes)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schemaNodes.id, row.id));
    changed.push(`${node.path}: ${diff}`);
  }

  const declaredPaths = new Set(declared.map((n) => n.path));
  const undeclared = existing.filter((row) => !declaredPaths.has(row.path));
  const bound = await boundPaths();

  /*
    A node the declaration dropped while something still names it. Deleting it
    would take the binding with it and the datum would stop printing with
    nothing on screen saying so — the exact failure this table exists to make
    impossible. So it is named, with its count, and left alone.
  */
  const wouldOrphan = undeclared
    .filter((row) => bound.has(row.path))
    .map((row) => `${row.path} (${bound.get(row.path)} binding(s))`);

  const removable = undeclared.filter((row) => !bound.has(row.path));
  if (prune && removable.length) {
    await db
      .delete(schemaNodes)
      .where(inArray(schemaNodes.id, removable.map((row) => row.id)));
  }

  return {
    declared: declared.length,
    added,
    changed,
    wouldOrphan,
    removable: removable.map((row) => row.path),
    pruned: prune,
  };
}

/** What actually differs, so the run says why a row was rewritten. */
function describeChange(
  row: { label: string; category: string; dataType: string; isRepeating: boolean; options: unknown; orderIndex: number },
  node: SchemaNode,
): string | null {
  const diffs: string[] = [];
  if (row.label !== node.label) diffs.push(`label ${q(row.label)} -> ${q(node.label)}`);
  if (row.dataType !== node.dataType) diffs.push(`type ${row.dataType} -> ${node.dataType}`);
  if (row.category !== node.category) diffs.push(`category ${row.category} -> ${node.category}`);
  if (row.isRepeating !== node.isRepeating) diffs.push(`repeating -> ${node.isRepeating}`);
  if (JSON.stringify(row.options ?? []) !== JSON.stringify(node.options ?? [])) {
    diffs.push("options");
  }
  if (row.orderIndex !== node.orderIndex) diffs.push("order");
  return diffs.length ? diffs.join(", ") : null;
}

const q = (s: string) => JSON.stringify(s);

/**
 * Which node paths something already names, and how many times.
 *
 * Read from the `field_key` strings rather than from `schema_node_id`, and
 * deliberately: a row that has not been bound yet still names its datum, and a
 * prune that consulted only the foreign keys would happily delete a node that
 * every unbound row in the table is about to point at.
 */
async function boundPaths(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const tally = (key: string) => {
    const { path } = pathOf(key);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  };

  for (const row of await db
    .select({ fieldKey: formFieldDefinitions.fieldKey })
    .from(formFieldDefinitions)) {
    tally(row.fieldKey);
  }
  for (const row of await db
    .select({ fieldKey: questionnaireQuestions.fieldKey })
    .from(questionnaireQuestions)) {
    if (row.fieldKey) tally(row.fieldKey);
  }

  return counts;
}

/**
 * ─── Resolve every `field_key` into a binding ────────────────────────────────
 *
 * Idempotent and re-runnable, not a one-shot migration: the catalogue seed adds
 * form fields whenever a form is re-extracted, and each arrives with a null
 * binding. Running this after it is what keeps the two in step.
 *
 * The report is the point of the exercise. Three outcomes, and only one of them
 * is a problem:
 *
 *   bound       the key names a node — the ordinary case
 *   formLocal   the key is the form's own name for a box nothing else asks
 *               (`i130.pt2.2_uscis_online_account_number`). Correct, and 86% of
 *               the catalogue. Counted, not listed.
 *   unresolved  the key looks like a shared datum and names no node
 *
 * That last list is what nothing could produce before. A well-formed key that
 * does not exist is indistinguishable from one that does — `populateCaseForms`
 * matches on the string, finds nothing, fills nothing and says nothing — so the
 * only report used to be a box printing blank inside a filing, weeks later.
 * Every entry is either a missing attribute in `global-schema.ts` or a typo
 * already sitting in the data.
 */
export async function bindToSchemaNodes() {
  const nodes = await db.select().from(schemaNodes);
  const byPath = new Map(nodes.map((node) => [node.path, node]));

  /*
    A key is the form's own if its first segment is that form's compacted code.
    The same rule `pdf-field-naming.ts` states, read from the catalogue rather
    than hard-coded, so a seventh form needs no change here.
  */
  const formCodes = await db
    .selectDistinct({ formCode: formDefinitions.formCode })
    .from(formDefinitions);
  const localPrefixes = new Set(formCodes.map((row) => formLocalPrefix(row.formCode)));
  const isFormLocal = (fieldKey: string) =>
    localPrefixes.has(fieldKey.split(".")[0] ?? "");

  return {
    formFields: await bindFormFields(byPath, isFormLocal),
    questions: await bindQuestions(byPath, isFormLocal),
  };
}

type Binding = { schemaNodeId: string | null; entryIndex: number | null };
type Row = { id: string; fieldKey: string | null } & Binding;

/**
 * Work out each row's binding, then write it in groups.
 *
 * Grouped rather than row by row because the I-485 alone is 512 fields and the
 * catalogue is 1,782: one statement per distinct `(node, entry)` pair is a few
 * hundred round trips instead of a few thousand, and the seed is run by hand
 * against a live database.
 */
export function resolveBindings(
  rows: Row[],
  byPath: Map<string, { id: string; isRepeating: boolean; dataType: string }>,
  isFormLocal: (fieldKey: string) => boolean,
  { allowEntryIndex }: { allowEntryIndex: boolean },
) {
  const wanted = new Map<string, string[]>();
  const key = (b: Binding) => `${b.schemaNodeId ?? ""}|${b.entryIndex ?? ""}`;

  let bound = 0;
  let formLocal = 0;
  let cleared = 0;
  const unresolved = new Set<string>();
  const misuse: string[] = [];

  for (const row of rows) {
    if (!row.fieldKey) continue;
    const { path, entryIndex } = pathOf(row.fieldKey);
    const node = byPath.get(path);

    let next: Binding = { schemaNodeId: null, entryIndex: null };

    if (!node) {
      if (isFormLocal(row.fieldKey)) formLocal++;
      else unresolved.add(row.fieldKey);
      if (row.schemaNodeId) cleared++;
    } else if (!allowEntryIndex && entryIndex !== null) {
      /*
        A question asks a whole list at once — `beneficiary.address_history` is
        one question answering many times. A question keyed at one entry of it
        would ask for the second address as though it were its own datum, and
        the client would be asked "where did you live before?" as a question
        that can only ever be answered once.
      */
      misuse.push(`${row.fieldKey} (a question may not name one entry)`);
    } else if (node.dataType === "repeat_group" && allowEntryIndex) {
      /*
        A form field bound to the list itself rather than to a leaf of it: the
        box would be asked to print the whole address history. Left unbound and
        named, because guessing which leaf was meant is how a wrong answer gets
        onto a form.
      */
      misuse.push(`${row.fieldKey} (a box cannot print a whole list)`);
    } else {
      next = { schemaNodeId: node.id, entryIndex: node.isRepeating ? entryIndex : null };
      bound++;
    }

    if (next.schemaNodeId === row.schemaNodeId && next.entryIndex === row.entryIndex) {
      continue;
    }
    const bucket = key(next);
    wanted.set(bucket, [...(wanted.get(bucket) ?? []), row.id]);
  }

  return { wanted, bound, formLocal, cleared, unresolved: [...unresolved].sort(), misuse };
}

async function bindFormFields(
  byPath: Map<string, { id: string; isRepeating: boolean; dataType: string }>,
  isFormLocal: (fieldKey: string) => boolean,
) {
  const rows = await db
    .select({
      id: formFieldDefinitions.id,
      fieldKey: formFieldDefinitions.fieldKey,
      schemaNodeId: formFieldDefinitions.schemaNodeId,
      entryIndex: formFieldDefinitions.entryIndex,
    })
    .from(formFieldDefinitions);

  const result = resolveBindings(rows, byPath, isFormLocal, { allowEntryIndex: true });

  for (const [bucket, ids] of result.wanted) {
    const [nodeId, entry] = bucket.split("|");
    await db
      .update(formFieldDefinitions)
      .set({
        schemaNodeId: nodeId || null,
        entryIndex: entry ? Number(entry) : null,
        updatedAt: new Date(),
      })
      .where(inArray(formFieldDefinitions.id, ids));
  }

  return { total: rows.length, written: [...result.wanted.values()].flat().length, ...strip(result) };
}

async function bindQuestions(
  byPath: Map<string, { id: string; isRepeating: boolean; dataType: string }>,
  isFormLocal: (fieldKey: string) => boolean,
) {
  const rows = await db
    .select({
      id: questionnaireQuestions.id,
      fieldKey: questionnaireQuestions.fieldKey,
      schemaNodeId: questionnaireQuestions.schemaNodeId,
      entryIndex: sql<number | null>`null`.as("entry_index"),
    })
    .from(questionnaireQuestions);

  const result = resolveBindings(rows, byPath, isFormLocal, { allowEntryIndex: false });

  for (const [bucket, ids] of result.wanted) {
    const [nodeId] = bucket.split("|");
    await db
      .update(questionnaireQuestions)
      .set({ schemaNodeId: nodeId || null, updatedAt: new Date() })
      .where(inArray(questionnaireQuestions.id, ids));
  }

  return {
    total: rows.filter((row) => row.fieldKey).length,
    written: [...result.wanted.values()].flat().length,
    ...strip(result),
  };
}

/** The report half of a resolve, without the write plan. */
const strip = ({ wanted: _wanted, ...report }: ReturnType<typeof resolveBindings>) => report;
