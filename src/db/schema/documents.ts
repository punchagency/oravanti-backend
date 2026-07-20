import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { cases } from "./cases";

export const documentCategoryEnum = pgEnum("document_category", [
  "application",
  "supporting",
  "identity",
  "uscis_response",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "active",
  "archived",
  "deleted",
]);

export const documentPermissionEnum = pgEnum("document_permission", [
  "VIEW",
  "COMMENT",
  "EDIT",
  "ADMIN",
]);

export const documentRequestStatusEnum = pgEnum("document_request_status", [
  "PENDING",
  "SUBMITTED",
  "PARTIALLY_SUBMITTED",
  "EXPIRED",
  "CANCELLED",
]);

/**
 * Antivirus scan outcome. Distinct from `aiScanStatusEnum` below — this axis is
 * about malware ("is this file safe to store/serve"), which is why it carries
 * INFECTED. The two were previously conflated under one `scanStatus` column.
 */
export const virusScanStatusEnum = pgEnum("virus_scan_status", [
  "PENDING",
  "CLEAN",
  "INFECTED",
  "FAILED",
  "SKIPPED",
]);

/**
 * AI document-review lifecycle for a document version. Denormalized read
 * optimisation only — `document_analyses` (keyed by checksum) is the source of
 * truth for the facts themselves.
 */
export const aiScanStatusEnum = pgEnum("ai_scan_status", [
  "pending",
  "queued",
  "running",
  "complete",
  "failed",
  "skipped",
]);

export const documentActivityActionEnum = pgEnum("document_activity_action", [
  "CREATED",
  "VIEWED",
  "DOWNLOADED",
  "VERSION_UPLOADED",
  "ACCESS_GRANTED",
  "ACCESS_REVOKED",
  "EXTERNAL_REQUEST_CREATED",
  "EXTERNAL_SUBMISSION_UPLOADED",
  "ARCHIVED",
  "RESTORED",
  "SOFT_DELETED",
]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    status: documentStatusEnum("status").notNull().default("active"),
    category: documentCategoryEnum("category"),
    createdByUserId: text("created_by_user_id").references(() => user.id),
    currentVersionId: uuid("current_version_id"),
    archivedAt: timestamp("archived_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("documents_created_by_user_idx").on(table.createdByUserId),
    index("documents_status_idx").on(table.status),
    index("documents_current_version_idx").on(table.currentVersionId),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    filePath: text("file_path").notNull(),
    fileUrl: text("file_url"),
    originalFileName: text("original_file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    checksum: text("checksum"),
    versionNumber: integer("version_number").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id),
    // ── Antivirus scan (malware) ──
    virusScanStatus: virusScanStatusEnum("virus_scan_status")
      .notNull()
      .default("PENDING"),
    virusScanProvider: text("virus_scan_provider"),
    virusScanResult: text("virus_scan_result"),
    virusScannedAt: timestamp("virus_scanned_at"),
    // ── AI document review (facts extraction) ──
    // Denormalized from document_analyses for cheap listing; the analyses table
    // (keyed by checksum) remains the source of truth.
    aiScanStatus: aiScanStatusEnum("ai_scan_status").notNull().default("pending"),
    aiScannedAt: timestamp("ai_scanned_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("document_versions_document_number_unique").on(
      table.documentId,
      table.versionNumber,
    ),
    index("document_versions_document_idx").on(table.documentId),
    index("document_versions_uploaded_by_idx").on(table.uploadedByUserId),
    index("document_versions_virus_scan_status_idx").on(table.virusScanStatus),
    index("document_versions_ai_scan_status_idx").on(table.aiScanStatus),
    // Checksum is the AI analysis cache key — indexed for cache lookups.
    index("document_versions_checksum_idx").on(table.checksum),
  ],
);

export const documentCaseLinks = pgTable(
  "document_case_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    linkedByUserId: text("linked_by_user_id").references(() => user.id),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("document_case_links_document_case_unique").on(
      table.documentId,
      table.caseId,
    ),
    index("document_case_links_document_idx").on(table.documentId),
    index("document_case_links_case_idx").on(table.caseId),
  ],
);

export const documentAccess = pgTable(
  "document_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    permission: documentPermissionEnum("permission").notNull(),
    grantedByUserId: text("granted_by_user_id").references(() => user.id),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("document_access_document_user_unique").on(
      table.documentId,
      table.userId,
    ),
    index("document_access_document_idx").on(table.documentId),
    index("document_access_user_idx").on(table.userId),
  ],
);

export const documentRequests = pgTable(
  "document_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id),
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    status: documentRequestStatusEnum("status").notNull().default("PENDING"),
    message: text("message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("document_requests_case_idx").on(table.caseId),
    index("document_requests_user_idx").on(table.requestedByUserId),
    index("document_requests_status_idx").on(table.status),
  ],
);

export const externalSubmissions = pgTable(
  "external_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => documentRequests.id),
    documentId: uuid("document_id").references(() => documents.id),
    documentVersionId: uuid("document_version_id").references(
      () => documentVersions.id,
    ),
    uploadedByName: text("uploaded_by_name").notNull(),
    uploadedByEmail: text("uploaded_by_email").notNull(),
    originalFileName: text("original_file_name").notNull(),
    filePath: text("file_path").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    virusScanStatus: virusScanStatusEnum("virus_scan_status")
      .notNull()
      .default("PENDING"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("external_submissions_request_idx").on(table.requestId),
    index("external_submissions_document_idx").on(table.documentId),
    index("external_submissions_version_idx").on(table.documentVersionId),
  ],
);

export const documentActivityLogs = pgTable(
  "document_activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").references(() => documents.id),
    actorUserId: text("actor_user_id").references(() => user.id),
    actorEmail: text("actor_email"),
    action: documentActivityActionEnum("action").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("document_activity_logs_document_idx").on(table.documentId),
    index("document_activity_logs_actor_idx").on(table.actorUserId),
    index("document_activity_logs_action_idx").on(table.action),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
export type DocumentCaseLink = typeof documentCaseLinks.$inferSelect;
export type NewDocumentCaseLink = typeof documentCaseLinks.$inferInsert;
export type DocumentAccess = typeof documentAccess.$inferSelect;
export type NewDocumentAccess = typeof documentAccess.$inferInsert;
export type DocumentRequest = typeof documentRequests.$inferSelect;
export type NewDocumentRequest = typeof documentRequests.$inferInsert;
export type ExternalSubmission = typeof externalSubmissions.$inferSelect;
export type NewExternalSubmission = typeof externalSubmissions.$inferInsert;
export type DocumentActivityLog = typeof documentActivityLogs.$inferSelect;
export type NewDocumentActivityLog = typeof documentActivityLogs.$inferInsert;
