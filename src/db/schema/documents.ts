import {
  boolean,
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
import { organization, user } from "./auth-schema";
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

export const documentTransferStatusEnum = pgEnum("document_transfer_status", [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

export const documentRequestStatusEnum = pgEnum("document_request_status", [
  "PENDING",
  "SUBMITTED",
  "PARTIALLY_SUBMITTED",
  "EXPIRED",
  "CANCELLED",
]);

export const documentScanStatusEnum = pgEnum("document_scan_status", [
  "PENDING",
  "CLEAN",
  "INFECTED",
  "FAILED",
  "SKIPPED",
]);

export const documentActivityActionEnum = pgEnum("document_activity_action", [
  "CREATED",
  "VIEWED",
  "DOWNLOADED",
  "VERSION_UPLOADED",
  "ACCESS_GRANTED",
  "ACCESS_REVOKED",
  "TRANSFER_REQUESTED",
  "TRANSFER_ACCEPTED",
  "TRANSFER_REJECTED",
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
    originFirmId: text("origin_firm_id")
      .notNull()
      .references(() => organization.id),
    currentOwnerFirmId: text("current_owner_firm_id").references(
      () => organization.id,
    ),
    currentVersionId: uuid("current_version_id"),
    archivedAt: timestamp("archived_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("documents_origin_firm_idx").on(table.originFirmId),
    index("documents_current_owner_firm_idx").on(table.currentOwnerFirmId),
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
    scanStatus: documentScanStatusEnum("scan_status")
      .notNull()
      .default("PENDING"),
    scanProvider: text("scan_provider"),
    scanResult: text("scan_result"),
    scannedAt: timestamp("scanned_at"),
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
    index("document_versions_scan_status_idx").on(table.scanStatus),
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

export const documentFirmAccess = pgTable(
  "document_firm_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    firmId: text("firm_id")
      .notNull()
      .references(() => organization.id),
    permission: documentPermissionEnum("permission").notNull(),
    grantedByUserId: text("granted_by_user_id").references(() => user.id),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("document_firm_access_document_firm_unique").on(
      table.documentId,
      table.firmId,
    ),
    index("document_firm_access_document_idx").on(table.documentId),
    index("document_firm_access_firm_idx").on(table.firmId),
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

export const documentTransfers = pgTable(
  "document_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    fromFirmId: text("from_firm_id")
      .notNull()
      .references(() => organization.id),
    toFirmId: text("to_firm_id")
      .notNull()
      .references(() => organization.id),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => user.id),
    toUserId: text("to_user_id").references(() => user.id),
    permission: documentPermissionEnum("permission").notNull(),
    status: documentTransferStatusEnum("status").notNull().default("PENDING"),
    message: text("message"),
    revokeSenderAccess: boolean("revoke_sender_access").notNull().default(false),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("document_transfers_document_idx").on(table.documentId),
    index("document_transfers_from_firm_idx").on(table.fromFirmId),
    index("document_transfers_to_firm_idx").on(table.toFirmId),
    index("document_transfers_status_idx").on(table.status),
  ],
);

export const documentRequests = pgTable(
  "document_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    requestedByFirmId: text("requested_by_firm_id")
      .notNull()
      .references(() => organization.id),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id),
    recipientFirmName: text("recipient_firm_name"),
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
    index("document_requests_firm_idx").on(table.requestedByFirmId),
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
    scanStatus: documentScanStatusEnum("scan_status")
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
export type DocumentFirmAccess = typeof documentFirmAccess.$inferSelect;
export type NewDocumentFirmAccess = typeof documentFirmAccess.$inferInsert;
export type DocumentAccess = typeof documentAccess.$inferSelect;
export type NewDocumentAccess = typeof documentAccess.$inferInsert;
export type DocumentTransfer = typeof documentTransfers.$inferSelect;
export type NewDocumentTransfer = typeof documentTransfers.$inferInsert;
export type DocumentRequest = typeof documentRequests.$inferSelect;
export type NewDocumentRequest = typeof documentRequests.$inferInsert;
export type ExternalSubmission = typeof externalSubmissions.$inferSelect;
export type NewExternalSubmission = typeof externalSubmissions.$inferInsert;
export type DocumentActivityLog = typeof documentActivityLogs.$inferSelect;
export type NewDocumentActivityLog = typeof documentActivityLogs.$inferInsert;
