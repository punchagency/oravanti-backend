import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * Purely cosmetic per-org role → color assignment (the accent shown on role
 * cards, badges, and the staff roles column). Deliberately its own table
 * rather than a column on better-auth's `organizationRole`: it applies to
 * every role including the statically-defined defaults (attorney, paralegal,
 * ...), which never have an `organizationRole` row of their own — see
 * `checkIfRoleNameIsTakenByPreDefinedRole` in better-auth's org plugin,
 * which refuses to let a DB role share a name with one in the static roster.
 */
export const roleAppearance = pgTable(
  "role_appearance",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    roleName: text("role_name").notNull(),
    color: text("color").notNull(),
    description: text("description").default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("roleAppearance_organizationId_roleName_idx").on(
      table.organizationId,
      table.roleName,
    ),
  ],
);

export type RoleAppearance = typeof roleAppearance.$inferSelect;
export type NewRoleAppearance = typeof roleAppearance.$inferInsert;
