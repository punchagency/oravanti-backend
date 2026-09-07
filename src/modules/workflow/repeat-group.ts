/**
 * Repeating answers, and how a form box asks for one of them.
 *
 * ─── The problem this exists for ────────────────────────────────────────────
 *
 * Every question in the bank answers exactly once — `questionnaire_answers` is
 * unique on `(response_id, question_id)`, which is right for "what is your date
 * of birth" and impossible for "where have you lived for the last five years".
 * USCIS asks the second kind constantly: the I-485 has a current address, a
 * prior address and a most recent address abroad; Part 7 is a list of children
 * and Part 6 a list of prior marriages.
 *
 * A question of type `repeat_group` answers with a **JSON array of objects**
 * instead of a scalar, and its `config` declares the sub-fields each object
 * holds. One row, one answer, one unique constraint — the list lives inside the
 * `jsonb` the column already was.
 *
 *     fieldKey: "beneficiary.address_history"
 *     value:    [{ street: "123 Main St", city: "Brooklyn", ... }, { ... }]
 *
 * ─── How a box asks for one entry ───────────────────────────────────────────
 *
 * A PDF box holds one value, so it names one entry and one sub-field:
 *
 *     beneficiary.address_history[1].street
 *
 * **The index is 1-based**, and deliberately: the only people who write these
 * keys are reading a USCIS blank while they do it, and the blank numbers its
 * blocks from one. `[1]` is the current address because the form's first block
 * is the current address. A 0-based index would be correct for the array and
 * wrong for every person using it.
 *
 * Nothing else about population changes. `form-population.service.ts` still
 * resolves a box by matching one string; this is the grammar that string may
 * additionally take.
 */

/** A field key that names one entry of a repeating answer. */
export type IndexedKey = {
  /** The question's own key, e.g. `beneficiary.address_history`. */
  base: string;
  /** Which entry, counting from 1. */
  index: number;
  /** Which sub-field of that entry, e.g. `street`. */
  leaf: string;
};

/*
  The base is greedy and the leaf is not, so a dotted base survives and a dotted
  leaf does not — `a.b[1].c.d` is entry 1 of `a.b`, sub-field `c.d`. Sub-fields
  are flat by design: an entry is a row on a form, and a row has no rows in it.
*/
const INDEXED = /^(.+)\[(\d+)\]\.([^[\]]+)$/;

/**
 * Read a key as naming one entry of a repeating answer, or `null` if it is an
 * ordinary key. Never throws — an unparseable key is simply not this kind.
 */
export function parseIndexedKey(fieldKey: string): IndexedKey | null {
  const match = INDEXED.exec(fieldKey);
  if (!match) return null;

  const index = Number(match[2]);
  // `[0]` is a mistake by someone who assumed 0-based, and filling entry 1 from
  // it would be a wrong answer that looks right. Refused rather than corrected.
  if (!Number.isInteger(index) || index < 1) return null;

  return { base: match[1], index, leaf: match[3] };
}

/** Whether a stored answer is shaped like a repeating one. */
export const isEntryList = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );

/**
 * The value one indexed key names, or `undefined` when the entry or sub-field
 * is not there.
 *
 * `undefined` rather than null throughout, because the caller distinguishes
 * "nothing to fill" from "fill this with an empty value" — a client who has
 * lived at one address must not have entry 2's boxes stamped with blanks.
 */
export function valueAtIndexedKey(
  answer: unknown,
  key: IndexedKey,
): unknown | undefined {
  if (!isEntryList(answer)) return undefined;

  const entry = answer[key.index - 1];
  if (!entry) return undefined;

  const value = entry[key.leaf];
  if (value === undefined || value === null || value === "") return undefined;

  return value;
}

/**
 * One sub-field of a repeating question, as its `config` declares it.
 *
 * The same shape a question has, minus the things an entry cannot carry: it has
 * no `fieldKey` of its own (the key is composed, above) and no logic rules
 * (a rule targets a question, and every entry shares one).
 */
export type RepeatGroupItemField = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  config?: { options?: string[] };
};

export type RepeatGroupConfig = {
  /** Singular, for the Add button and each entry's heading: "Address". */
  itemLabel: string;
  /** How many entries the form has room for. Beyond it goes on a continuation sheet. */
  maxItems?: number;
  fields: RepeatGroupItemField[];
};

/**
 * Read a question's `config` as a repeat group's, or `null` if it is not one.
 *
 * Defensive because `config` is `jsonb` with no schema behind it, and this is
 * read on the population path — where a malformed config must fill nothing
 * rather than throw and abandon the other forty fields in the pass.
 */
export function asRepeatGroupConfig(
  config: unknown,
): RepeatGroupConfig | null {
  if (typeof config !== "object" || config === null) return null;

  const candidate = config as Partial<RepeatGroupConfig>;
  if (!Array.isArray(candidate.fields) || candidate.fields.length === 0) {
    return null;
  }
  if (
    !candidate.fields.every(
      (field) =>
        typeof field?.key === "string" && typeof field?.label === "string",
    )
  ) {
    return null;
  }

  return {
    itemLabel: candidate.itemLabel ?? "Entry",
    maxItems: candidate.maxItems,
    fields: candidate.fields,
  };
}

/**
 * The vocabulary node a field key names, and which entry of it if any.
 *
 * `beneficiary.address_history[2].city` is the *city of an address* — one
 * datum — printed for the second entry. The vocabulary holds it once however
 * many entries a form prints, because the I-485 printing two addresses and the
 * I-130 printing one is a fact about those forms and must not fork the datum in
 * two. So the key splits: `[]` for the node, the number for the binding.
 *
 * Total, like everything else here: a key that is not indexed is simply its own
 * path with no entry.
 */
export const pathOf = (
  fieldKey: string,
): { path: string; entryIndex: number | null } => {
  const indexed = parseIndexedKey(fieldKey);
  return indexed
    ? { path: `${indexed.base}[].${indexed.leaf}`, entryIndex: indexed.index }
    : { path: fieldKey, entryIndex: null };
};

/**
 * What a field key may look like on the wire.
 *
 * Every endpoint that takes one validates it by *shape* — the catalogue is
 * seeded content that grows, so the real check is against
 * `form_field_definitions`, and this only keeps a malformed key out of a query.
 * It lives here rather than in each module's validation file because the shape
 * it has to admit is the grammar above, and the two drifting apart is not a
 * validation error: it is a save that a person cannot complete.
 *
 * That is exactly what happened. The key was `^[a-z0-9_]+(\.[a-z0-9_]+)*$` in
 * both `case-details.validation.ts` and `platform.validation.ts`, which admits
 * `beneficiary.city` and refuses `beneficiary.address_history[2].city` — a key
 * the I-485 carries 80 of, the I-864 14 and the I-130 9, written by
 * `<code>.field-sources.json` and renamed onto the definition by the catalogue
 * seed. Saving one field at a time worked as long as nobody touched a repeating
 * one; saving a whole form sent every changed field in one batch, so a single
 * repeating field 400'd the lot.
 */
export const FIELD_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)*(\[\d+\]\.[a-z0-9_]+)?$/;
