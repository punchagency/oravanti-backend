import { z } from "zod";

/**
 * ─── The vocabulary, as nodes ────────────────────────────────────────────────
 *
 * `global-schema.ts` declares what this system knows about an immigration
 * matter, as one Zod graph. This file is the machinery under it: the leaf
 * constructors that graph is written with, and the flattener that turns it
 * into the rows `schema_nodes` holds.
 *
 * The split is for reading. `global-schema.ts` should be 150 lines of nothing
 * but vocabulary — a paralegal ought to be able to check it against a USCIS
 * blank — so every mechanism lives here instead.
 */

/** Mirrors `questionnaire_question_type`. A node's type is how it is asked. */
export type SchemaDataType =
  | "short_text"
  | "long_text"
  | "number"
  | "email"
  | "phone"
  | "date"
  | "single_choice"
  | "multiple_choice"
  | "dropdown"
  | "yes_no"
  | "repeat_group";

/** One row of `schema_nodes`. `path` is the key everything else joins on. */
export type SchemaNode = {
  /** `beneficiary.date_of_birth`, `family.children[].given_name`. */
  path: string;
  label: string;
  /** The first path segment: beneficiary, petitioner, marriage, … */
  category: string;
  dataType: SchemaDataType;
  /**
   * True when an answer to this node is *per entry* — the node is a list, or
   * lives inside one, i.e. its path carries `[]`. This is what tells a form
   * field binding it needs an `entryIndex`: `beneficiary.address_history[].city`
   * is a different datum on the current address and on the previous one.
   */
  isRepeating: boolean;
  /** Declaration order, which is the order a picker offers them in. */
  orderIndex: number;
  /** Choices, for the three types that have them. */
  options?: readonly string[];
};

type LeafMeta = { label: string; dataType: SchemaDataType; options?: readonly string[] };

/**
 * A leaf is a node carrying `dataType`; everything else is structure the walk
 * descends through. Marking leaves rather than inferring them from the Zod
 * type is what lets `multiple_choice` be a `z.array` (of choices — one answer)
 * while `repeat_group` is also a `z.array` (of entries — many answers), and
 * `z.iso.date()`, which reports itself as a string, still be a date.
 */
const leaf = <T extends z.ZodType>(schema: T, meta: LeafMeta) => schema.meta(meta);

export const text = (label: string) => leaf(z.string(), { label, dataType: "short_text" });
export const longText = (label: string) => leaf(z.string(), { label, dataType: "long_text" });
export const number = (label: string) => leaf(z.number(), { label, dataType: "number" });
export const email = (label: string) => leaf(z.email(), { label, dataType: "email" });
export const phone = (label: string) => leaf(z.string(), { label, dataType: "phone" });
export const date = (label: string) => leaf(z.iso.date(), { label, dataType: "date" });
export const yesNo = (label: string) => leaf(z.boolean(), { label, dataType: "yes_no" });

type Options = readonly [string, ...string[]];

/** Radio buttons on the blank: one answer from a short list. */
export const choice = (label: string, options: Options) =>
  leaf(z.enum(options), { label, dataType: "single_choice", options });

/** A long list — states, heights — where the blank prints a select. */
export const dropdown = (label: string, options: Options) =>
  leaf(z.enum(options), { label, dataType: "dropdown", options });

/** Check all that apply. One answer, several values — not a repeat group. */
export const multiChoice = (label: string, options: Options) =>
  leaf(z.array(z.enum(options)), { label, dataType: "multiple_choice", options });

/**
 * A question that answers more than once — an address history, the children.
 * The entries live inside one `jsonb` answer; see `repeat-group.ts` for the
 * `key[n]` grammar a form field uses to print one of them.
 */
export const list = <T extends z.ZodType>(label: string, entry: T) =>
  leaf(z.array(entry), { label, dataType: "repeat_group" });

const metaOf = (schema: z.ZodType): LeafMeta | undefined =>
  schema.meta() as LeafMeta | undefined;

/**
 * Walk the graph and emit one row per leaf, plus one per list.
 *
 * Total by construction: a node that is neither a leaf nor something to
 * descend into throws, rather than being skipped. A vocabulary that silently
 * loses an attribute is the failure this whole table exists to prevent — a
 * form field bound to a node nothing declares prints blank, weeks later,
 * inside a filing.
 */
export const flattenSchema = (root: z.ZodType): SchemaNode[] => {
  const nodes: SchemaNode[] = [];

  const walk = (schema: z.ZodType, path: string): void => {
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
      return walk(schema.unwrap() as z.ZodType, path);
    }

    const meta = metaOf(schema);
    const emit = (dataType: SchemaDataType): void => {
      nodes.push({
        path,
        label: meta?.label ?? path,
        category: path.split(".")[0]!,
        dataType,
        isRepeating: path.includes("[]"),
        orderIndex: nodes.length,
        ...(meta?.options ? { options: meta.options } : {}),
      });
    };

    if (meta?.dataType === "repeat_group") {
      emit("repeat_group");
      // The list itself is not repeating; what is inside it is.
      nodes[nodes.length - 1]!.isRepeating = true;
      return walk((schema as unknown as z.ZodArray<z.ZodType>).element, `${path}[]`);
    }

    if (meta?.dataType) return emit(meta.dataType);

    if (schema instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }

    throw new Error(
      `global schema: "${path || "<root>"}" is neither a declared leaf nor an object. ` +
        `Build it with one of the constructors in lib/schema/nodes.ts.`,
    );
  };

  walk(root, "");
  return nodes;
};
