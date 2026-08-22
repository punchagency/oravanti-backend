import {
  boolean,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";
import { leads } from "./leads";
import { staff } from "./staff";
import { portalStatusEnum } from "./enums";

// =========================================================================
// CLIENT ENUMS
// =========================================================================

export const clientEntityTypeEnum = pgEnum("client_entity_type", [
  "individual",
  "company",
  "trust",
  "estate",
  "other",
]);

export const clientStatusEnum = pgEnum("client_status", [
  "active",
  "inactive",
  "pending",
]);

export const clientNoteTypeEnum = pgEnum("client_note_type", [
  "general",
  "billing_preference",
  "relationship_management",
  "system_log",
]);

// =========================================================================
// CLIENT TABLES
// =========================================================================

/**
 * Clients Table: The central legal entity profile ledger.
 * Represents an overarching account entity (can be created from a Lead, or completely standalone).
 */
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),

  // Link to user account (for client portal access)
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

  // Historical conversion audit trail linkage (Safe clean decoupling)
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),

  entityType: clientEntityTypeEnum("entity_type")
    .notNull()
    .default("individual"),
  status: clientStatusEnum("status").notNull().default("active"),

  // Unified overarching point-of-contact structural identifiers
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  displayName: text("display_name").notNull(), // e.g., "John Doe" or "Stark Industries Inc"
  email: text("email").notNull(),
  phone: text("phone"),
  avatarUrl: text("avatar_url"),

  // SMS consent. Sendable ONLY when smsConsent is true and smsOptOutAt is null
  // — see hasSmsConsent, which owns that invariant for both leads and clients.
  //
  // Consent does NOT carry over when a lead converts to a client: the columns
  // are copied explicitly at conversion, so the fact stays attached to the row
  // it was recorded against rather than being inferred.
  smsConsent: boolean("sms_consent").notNull().default(false),
  smsConsentAt: timestamp("sms_consent_at"),
  // "intake_form" | "staff_manual" | "sms_start"
  smsConsentSource: text("sms_consent_source"),
  smsOptOutAt: timestamp("sms_opt_out_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  tempPassword: text("temp_password"),
  portalStatus: portalStatusEnum("portal_status").notNull().default("none"),
});

/**
 * Client Notes Table: Tracks high-level legal global CRM accounts notes (e.g. billing traits).
 */
export const clientNotes = pgTable("client_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  authorId: uuid("author_id")
    .notNull()
    .references(() => staff.id),
  type: clientNoteTypeEnum("type").notNull().default("general"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Junction Table: Handles assigning a multi-layered legal firm structure (Teams) to an active Client.
 */
export const clientsToTeams = pgTable(
  "clients_to_teams",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  },
  (t) => [{ pk: primaryKey({ columns: [t.clientId, t.teamId] }) }],
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type ClientNote = typeof clientNotes.$inferSelect;
