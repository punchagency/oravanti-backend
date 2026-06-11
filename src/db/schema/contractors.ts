import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { documents } from "./documents";
import { practiceAreaCaseTypes } from "./practice-area-case-types";

export const contractorAvailabilityEnum = pgEnum("contractor_availability", [
  "full-time",
  "part-time",
  "project-based",
]);

export const contractorStatusEnum = pgEnum("contractor_status", [
  "pending",
  "under_review",
  "active",
  "rejected",
  "suspended",
]);

export const contractorPaymentMethodEnum = pgEnum(
  "contractor_payment_method",
  ["paypal", "bank_account"],
);

export const contractorCertificationVerificationStatusEnum = pgEnum(
  "contractor_certification_verification_status",
  ["pending", "verified", "rejected"],
);

export const contractors = pgTable(
  "contractors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phoneNumber: text("phone_number").notNull(),
    desiredHourlyRate: numeric("desired_hourly_rate", {
      precision: 10,
      scale: 2,
    }).notNull(),
    consentedToBackgroundCheck: boolean("consented_to_background_check")
      .notNull()
      .default(false),
    recognizedDirectoryListingVerificationAccepted: boolean(
      "recognized_directory_listing_verification_accepted",
    )
      .notNull()
      .default(false),
    bio: text("bio").notNull(),
    availability: contractorAvailabilityEnum("availability").notNull(),
    status: contractorStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contractors_user_uidx").on(table.userId),
    uniqueIndex("contractors_email_uidx").on(table.email),
    index("contractors_status_idx").on(table.status),
    index("contractors_availability_idx").on(table.availability),
  ],
);

export const contractorSpecialties = pgTable(
  "contractor_specialties",
  {
    contractorId: uuid("contractor_id")
      .notNull()
      .references(() => contractors.id, { onDelete: "cascade" }),
    practiceAreaCaseTypeId: uuid("practice_area_case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.contractorId, table.practiceAreaCaseTypeId],
    }),
    index("contractor_specialties_case_type_idx").on(
      table.practiceAreaCaseTypeId,
    ),
  ],
);

export const contractorPaymentDetails = pgTable(
  "contractor_payment_details",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id")
      .notNull()
      .unique()
      .references(() => contractors.id, { onDelete: "cascade" }),
    paymentMethod: contractorPaymentMethodEnum("payment_method").notNull(),
    paypalEmail: text("paypal_email"),
    accountHolderName: text("account_holder_name"),
    encryptedRoutingNumber: text("encrypted_routing_number"),
    encryptedAccountNumber: text("encrypted_account_number"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contractor_payment_details_contractor_uidx").on(
      table.contractorId,
    ),
  ],
);

export const contractorCertificationDocuments = pgTable(
  "contractor_certification_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id")
      .notNull()
      .references(() => contractors.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    certificationName: text("certification_name").notNull(),
    issuingOrganization: text("issuing_organization"),
    issuedAt: date("issued_at"),
    expiresAt: date("expires_at"),
    verificationStatus:
      contractorCertificationVerificationStatusEnum("verification_status")
        .notNull()
        .default("pending"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id),
    reviewedAt: timestamp("reviewed_at"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contractor_certification_documents_document_uidx").on(
      table.documentId,
    ),
    index("contractor_certification_documents_contractor_idx").on(
      table.contractorId,
    ),
    index("contractor_certification_documents_status_idx").on(
      table.verificationStatus,
    ),
  ],
);

export const contractorIdentificationDocuments = pgTable(
  "contractor_identification_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id")
      .notNull()
      .references(() => contractors.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    verificationStatus:
      contractorCertificationVerificationStatusEnum("verification_status")
        .notNull()
        .default("pending"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id),
    reviewedAt: timestamp("reviewed_at"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contractor_identification_documents_document_uidx").on(
      table.documentId,
    ),
    uniqueIndex("contractor_identification_documents_position_uidx").on(
      table.contractorId,
      table.position,
    ),
    index("contractor_identification_documents_contractor_idx").on(
      table.contractorId,
    ),
    index("contractor_identification_documents_status_idx").on(
      table.verificationStatus,
    ),
  ],
);

export type Contractor = typeof contractors.$inferSelect;
export type NewContractor = typeof contractors.$inferInsert;
export type ContractorSpecialty = typeof contractorSpecialties.$inferSelect;
export type NewContractorSpecialty = typeof contractorSpecialties.$inferInsert;
export type ContractorPaymentDetail =
  typeof contractorPaymentDetails.$inferSelect;
export type NewContractorPaymentDetail =
  typeof contractorPaymentDetails.$inferInsert;
export type ContractorCertificationDocument =
  typeof contractorCertificationDocuments.$inferSelect;
export type NewContractorCertificationDocument =
  typeof contractorCertificationDocuments.$inferInsert;
export type ContractorIdentificationDocument =
  typeof contractorIdentificationDocuments.$inferSelect;
export type NewContractorIdentificationDocument =
  typeof contractorIdentificationDocuments.$inferInsert;
