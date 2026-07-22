import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { documents } from "./documents";
import { leads } from "./leads";
import { staff } from "./staff";

export const leadDocumentLinks = pgTable(
  "lead_document_links",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),
    documentId:     uuid("document_id").notNull().references(() => documents.id),
    leadId:         uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    linkedByStaffId: uuid("linked_by_staff_id").references(() => staff.id),
    archivedAt:     timestamp("archived_at"),
    createdAt:      timestamp("created_at").notNull().defaultNow(),
    updatedAt:      timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("lead_document_links_document_lead_unique").on(table.documentId, table.leadId),
    index("lead_document_links_organization_idx").on(table.organizationId),
    index("lead_document_links_document_idx").on(table.documentId),
    index("lead_document_links_lead_idx").on(table.leadId),
  ],
);

export type LeadDocumentLink = typeof leadDocumentLinks.$inferSelect;
export type NewLeadDocumentLink = typeof leadDocumentLinks.$inferInsert;
