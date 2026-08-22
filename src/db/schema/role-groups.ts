import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, member } from "./auth-schema";

/**
 * Role groups let an admin bundle multiple roles into a named set and
 * assign staff to the group instead of individually tagging each role.
 *
 * A staff member's effective roles = their direct `member.role` union
 * with all roles from every `role_group` they belong to. Groups are
 * purely additive — they can only widen access, never narrow it.
 */
export const roleGroup = pgTable(
  "role_group",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default(""),
    /** Comma-separated role names (same format as `member.role`). */
    roles: text("roles").default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("roleGroup_organizationId_name_uidx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

/**
 * Junction table — which members belong to which role groups.
 * A member can be in many groups; a group can have many members.
 */
export const roleGroupMember = pgTable(
  "role_group_member",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => roleGroup.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("roleGroupMember_groupId_memberId_uidx").on(
      table.groupId,
      table.memberId,
    ),
  ],
);

export type RoleGroup = typeof roleGroup.$inferSelect;
export type NewRoleGroup = typeof roleGroup.$inferInsert;
export type RoleGroupMember = typeof roleGroupMember.$inferSelect;
