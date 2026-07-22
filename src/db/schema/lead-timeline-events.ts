import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { leads } from "./leads";
import { staff } from "./staff";

export const leadTimelineEvents = pgTable("lead_timeline_events", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  leadId:         uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  eventType:      text("event_type").notNull(),
  title:          text("title").notNull(),
  description:    text("description"),
  metadata:       jsonb("metadata"),
  createdById:    uuid("created_by_id").references(() => staff.id),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("lead_timeline_events_organization_idx").on(table.organizationId),
]);

export type LeadTimelineEvent = typeof leadTimelineEvents.$inferSelect;
export type NewLeadTimelineEvent = typeof leadTimelineEvents.$inferInsert;
