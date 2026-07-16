import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { staff } from "./staff";

export const leadTimelineEvents = pgTable("lead_timeline_events", {
  id:          uuid("id").primaryKey().defaultRandom(),
  leadId:      uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  eventType:   text("event_type").notNull(),
  title:       text("title").notNull(),
  description: text("description"),
  metadata:    jsonb("metadata"),
  createdById: uuid("created_by_id").references(() => staff.id),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type LeadTimelineEvent = typeof leadTimelineEvents.$inferSelect;
export type NewLeadTimelineEvent = typeof leadTimelineEvents.$inferInsert;
