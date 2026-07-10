import { pgTable, uuid, text, date, timestamp, pgEnum, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { clients } from "./clients";
import { leads } from "./leads";

// =========================================================================
// CONTACT ENUMS
// =========================================================================

export const contactTypeEnum = pgEnum("contact_type", [
  "primary_client",
  "co_client",
  "corporate_representative",
  "spouse",
  "dependent",
  "emergency_contact",
  "authorized_third_party",
]);

export const languagePreferenceEnum = pgEnum("language_preference", [
  "en", "es", "fr", "de", "zh", "vi", "ar", "pt", "other",
]);

export const genderEnum = pgEnum("contact_gender", [
  "male",
  "female",
  "non_binary",
  "prefer_not_to_say",
]);

// =========================================================================
// CONTACT TABLES
// =========================================================================

/**
 * Client Contacts Table: The explicit single source of truth for human metadata.
 * Holds precise identifiers for legal forms and court document assemblies.
 */
export const clientContacts = pgTable(
  "client_contacts",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),
    
    // Identity linkages
    clientId:       uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    leadId:         uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    
    // Explicit system status identifier (e.g. tracks who is the primary target)
    type:           contactTypeEnum("type").notNull().default("primary_client"),
    
    // Highly specific segmented legal identity text blocks
    firstName:      text("first_name").notNull(),
    middleName:     text("middle_name"),
    lastName:       text("last_name").notNull(),
    secondLastName: text("second_last_name"),
    thirdLastName:  text("third_last_name"),
    fourthLastName: text("fourth_last_name"),
    
    email:          text("email").notNull(),
    phone:          text("phone"),
    languagePreference: languagePreferenceEnum("language_preference").notNull().default("en"),
    
    // Advanced legal/court demographic vectors
    dateOfBirth:       date("date_of_birth"),
    gender:            genderEnum("gender"),
    preferredPronouns: text("preferred_pronouns"),
    taxIdOrSsn:        text("tax_id_or_ssn"), // Recommended to application-level encrypt this
    
    // International processing details (e.g. Corporate KYC or Immigration)
    nationality:            text("nationality"),
    countryOfOrigin:        text("country_of_origin"),
    passportNumber:         text("passport_number"),
    passportExpirationDate: date("passport_expiration_date"),
    
    // Highly granular structured geographical components
    addressStreet1:    text("address_street_1"),
    addressStreet2:    text("address_street_2"),
    addressCity:       text("address_city"),
    addressState:      text("address_state"),
    addressPostalCode: text("address_postal_code"),
    addressCountry:    text("address_country"),
    
    // High-stakes crisis risk handling properties
    emergencyContactName:         text("emergency_contact_name"),
    emergencyContactPhone:        text("emergency_contact_phone"),
    emergencyContactRelationship: text("emergency_contact_relationship"),
    
    portalUserId:   text("portal_user_id"), // Linked secure auth system entry
    createdAt:      timestamp("created_at").notNull().defaultNow(),
    updatedAt:      timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("client_contacts_org_email_unique").on(t.organizationId, t.email),
  ],
);

export type ClientContact = typeof clientContacts.$inferSelect;
export type NewClientContact = typeof clientContacts.$inferInsert; 
