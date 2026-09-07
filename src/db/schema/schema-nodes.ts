import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { questionnaireQuestionTypeEnum } from "./enums";

/**
 * ─── The vocabulary, as rows ─────────────────────────────────────────────────
 *
 * One row per datum this system knows about a matter — `beneficiary.date_of_birth`,
 * `family.children[].given_name`. A questionnaire question asks for a node; a
 * form field prints one; population carries the answer across because both
 * point at the same row.
 *
 * The join between a question and a box used to be a bare string on both sides,
 * matched exactly and checked by nothing. A key one character off matched no
 * box, filled nothing, and reported nothing — the form printed blank, weeks
 * later, inside a filing, and no validation could catch it because a
 * well-formed key that does not exist looks exactly like one that does. This
 * table is that string with a primary key on it, so the mismatch is a foreign
 * key violation at write time instead of a blank box at filing time.
 *
 * Platform reference data. There is nothing tenant-specific about what a date
 * of birth is, so there is no `organization_id` here — a firm extends the
 * *questionnaire*, not the vocabulary. A firm question that asks something this
 * table does not name is fine and common; it simply binds to no node and prints
 * nowhere, which is exactly what a firm's own question should do.
 *
 * ── Seeded, never hand-edited ──
 *
 * `src/lib/schema/global-schema.ts` is the declaration; `seedSchemaNodes` walks
 * it and writes these rows. Editing a row here and not the file means the next
 * seed run puts it back. The seed refuses to delete a node that questions or
 * form fields still point at, and names them instead — an orphaned binding is
 * how a datum stops printing silently.
 */
export const schemaNodes = pgTable(
  "schema_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The key everything else joins on, and the same string that has been
     * living in `field_key` all along: `beneficiary.date_of_birth`.
     *
     * A node inside a repeating list carries `[]` and no index —
     * `beneficiary.address_history[].city` is *the city of an address*, once,
     * however many addresses a client has. Which entry a particular box prints
     * is the binding's business (`form_field_definitions.entry_index`), not the
     * vocabulary's: the I-485 printing two addresses and the I-130 printing one
     * is a fact about those forms, and it must not fork the datum in two.
     */
    path: text("path").notNull().unique(),
    /** What to call it on screen — a picker label, not the question's wording. */
    label: text("label").notNull(),
    /**
     * The first segment of `path`: beneficiary, petitioner, marriage, family,
     * biographic, immigration, employment, sponsor, medical, travel.
     *
     * Stored rather than derived at read time because it is what the field
     * picker groups by, and a `GROUP BY` beats splitting 155 strings in every
     * caller. It is still only ever the first segment — nothing may set it to
     * something the path does not say.
     */
    category: text("category").notNull(),
    /** How it is asked. Same enum the questions and form fields use. */
    dataType: questionnaireQuestionTypeEnum("data_type").notNull(),
    /**
     * True when an answer to this node is *per entry* — the node is a list, or
     * lives inside one. This is what tells a binding it needs an `entry_index`,
     * and what stops a repeating datum being bound as though there were one of
     * it.
     */
    isRepeating: boolean("is_repeating").notNull().default(false),
    /** Choices, for `single_choice`, `multiple_choice` and `dropdown`. */
    options: jsonb("options").notNull().default([]),
    /** Declaration order in `global-schema.ts` — the order a picker offers. */
    orderIndex: integer("order_index").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("schema_nodes_category_idx").on(t.category, t.orderIndex),
  ],
);

export type SchemaNodeRow = typeof schemaNodes.$inferSelect;
export type NewSchemaNodeRow = typeof schemaNodes.$inferInsert;
