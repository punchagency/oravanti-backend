import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Whether a taxonomy node is still offered.
 *
 * ─── Why an enum and not a boolean ──────────────────────────────────────────
 *
 * `is_active` answers one question and can never answer another. A third state
 * is a schema change plus every `WHERE is_active` in the codebase; a third enum
 * value is a migration and the readers that care. "Coming soon", "deprecated —
 * use this other one", "internal only" are all plausible next values, and none
 * of them is expressible as a second boolean without the pair having a
 * meaningless fourth combination.
 *
 * ─── What the two current values mean ───────────────────────────────────────
 *
 * - `active` — offered everywhere. The default, because a node somebody just
 *   created in the CMS is one they intend to use.
 * - `archived` — kept, not offered. Every matter, lead and invoice already
 *   filed under it keeps working and keeps reporting; what stops is being
 *   listed when somebody opens a *new* one.
 *
 * That distinction is the whole reason this column exists rather than a delete
 * button. Deleting a case type with history is refused by the database (`cases`
 * and `leads` hold it with no cascade) and deleting one without history would
 * still take a firm's workflow template and staff assignments with it, because
 * those *do* cascade. Archiving is the operation an operator actually wants
 * when they say "stop offering this".
 *
 * Readers must treat an unknown value as not-offered rather than throwing: a
 * value added in a later deployment reaches a running one, and a picker that
 * crashes is worse than a picker missing a row.
 */
export const taxonomyStatusEnum = pgEnum("taxonomy_status", [
  "active",
  "archived",
]);

export type TaxonomyStatus = (typeof taxonomyStatusEnum.enumValues)[number];
