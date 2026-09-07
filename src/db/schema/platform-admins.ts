import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

/**
 * Oravanti's own staff — the operators of the platform, not of a firm.
 *
 * ─── Why this is not `admins` ───────────────────────────────────────────────
 *
 * `db/schema/admins.ts` sounds like this table and is not. Its
 * `organization_id` is `NOT NULL UNIQUE`, so it models "the administrator *of*
 * one firm" — a tenant record. This one has no organization column at all, and
 * that absence is the entire design:
 *
 *   - `requireAuth` opens a tenant-scoped connection only when it resolves an
 *     organization, and a platform admin has none — so every query it makes
 *     runs on `systemDb`, the connection that can write the platform rows
 *     (`organization_id IS NULL`) that RLS forbids any tenant connection from
 *     inserting.
 *   - `resolveActorContext` refuses a platform admin outright, so one can
 *     never acquire a tenant context by any other route. **Oravanti staff see
 *     no firm data**, and that is true by construction rather than by
 *     convention.
 *
 * Membership is the whole authorisation story: a row here means platform
 * admin, and there is no second kind. Roles *within* this tier can be added
 * when there is a second kind of operator to distinguish.
 *
 * There is deliberately no signup or invitation path. The first row is written
 * by `npm run cli` → "Seed a platform admin", and subsequent ones from the CRM
 * — an operator tier reachable from a public form would be a defect.
 */
export const platformAdmins = pgTable("platform_admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The better-auth account. `unique` because one person is one operator; the
   * lookup in `requirePlatformAdmin` is on this column.
   */
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PlatformAdmin = typeof platformAdmins.$inferSelect;
export type NewPlatformAdmin = typeof platformAdmins.$inferInsert;
