import { z } from "zod";
import {
  contactTypeEnum,
  genderEnum,
  languagePreferenceEnum,
} from "../../db/schema/client-contacts";
import { companyTypeEnum } from "../../db/schema/client-companies";
import { clientEntityTypeEnum, clientStatusEnum } from "../../db/schema/clients";

/**
 * Request schemas for the clients module.
 *
 * Replaces `CommonValidation.optionalBody()` on the three update endpoints.
 * That helper was `z.object({}).passthrough()` — it accepted any object, and
 * the services spread it straight into `.set()`. On `clients` that meant a
 * request could write `organizationId` and move a client record to another
 * firm, or set `portalStatus`/`tempPassword` directly.
 *
 * Enum values are derived from the Drizzle enums so they cannot drift.
 */

const uuid = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format");

/** Rejects an empty patch so `PATCH` with `{}` is a 400 rather than a no-op write. */
const nonEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine((body) => Object.keys(body as object).length > 0, {
    message: "Provide at least one field to update",
  });

// ── Params ───────────────────────────────────────────────────────────────────

export const clientIdParams = z.object({ id: uuid });
export const contactParams = z.object({ id: uuid, contactId: uuid });

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Writable surface of a client record.
 *
 * Deliberately absent: `organizationId`, `userId`, `leadId` (tenancy and
 * provenance), `portalStatus` and `tempPassword` (owned by the portal
 * invitation flow, which has its own endpoint), `avatarUrl` (set by the avatar
 * upload route), and the timestamps.
 */
export const updateClientBody = nonEmpty(
  z
    .object({
      firstName: z.string().trim().min(1).max(120).optional(),
      lastName: z.string().trim().min(1).max(120).optional(),
      displayName: z.string().trim().min(1).max(240).optional(),
      email: z.string().trim().email().max(320).optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      status: z.enum(clientStatusEnum.enumValues).optional(),
      entityType: z.enum(clientEntityTypeEnum.enumValues).optional(),
    })
    .strict(),
);

// ── Contacts ─────────────────────────────────────────────────────────────────

const contactFields = {
  type: z.enum(contactTypeEnum.enumValues).optional(),
  firstName: z.string().trim().min(1).max(120),
  middleName: z.string().trim().max(120).nullable().optional(),
  lastName: z.string().trim().min(1).max(120),
  secondLastName: z.string().trim().max(120).nullable().optional(),
  thirdLastName: z.string().trim().max(120).nullable().optional(),
  fourthLastName: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).nullable().optional(),
  languagePreference: z.enum(languagePreferenceEnum.enumValues).optional(),
  dateOfBirth: isoDate.nullable().optional(),
  gender: z.enum(genderEnum.enumValues).nullable().optional(),
  preferredPronouns: z.string().trim().max(60).nullable().optional(),
  taxIdOrSsn: z.string().trim().max(60).nullable().optional(),
  nationality: z.string().trim().max(120).nullable().optional(),
  countryOfOrigin: z.string().trim().max(120).nullable().optional(),
  passportNumber: z.string().trim().max(60).nullable().optional(),
  passportExpirationDate: isoDate.nullable().optional(),
  addressStreet1: z.string().trim().max(240).nullable().optional(),
  addressStreet2: z.string().trim().max(240).nullable().optional(),
  addressCity: z.string().trim().max(120).nullable().optional(),
  addressState: z.string().trim().max(120).nullable().optional(),
  addressPostalCode: z.string().trim().max(30).nullable().optional(),
  addressCountry: z.string().trim().max(120).nullable().optional(),
  emergencyContactName: z.string().trim().max(240).nullable().optional(),
  emergencyContactPhone: z.string().trim().max(40).nullable().optional(),
  emergencyContactRelationship: z.string().trim().max(120).nullable().optional(),
} as const;

/** `clientId`, `organizationId` and `portalUserId` are set by the service, not the caller. */
export const createContactBody = z.object(contactFields).strict();

export const updateContactBody = nonEmpty(
  z.object(contactFields).partial().strict(),
);

// ── Company ──────────────────────────────────────────────────────────────────

export const upsertCompanyBody = z
  .object({
    companyName: z.string().trim().min(1).max(240),
    companyType: z.enum(companyTypeEnum.enumValues),
    ein: z.string().trim().max(30).nullable().optional(),
    industry: z.string().trim().max(120).nullable().optional(),
    numberOfEmployees: z.number().int().min(0).max(10_000_000).nullable().optional(),
    address: z.string().trim().min(1).max(240),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    zipCode: z.string().trim().max(30).nullable().optional(),
    country: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(40).nullable().optional(),
    website: z.string().trim().url().max(500).nullable().optional(),
  })
  .strict();

export type UpdateClientInput = z.infer<typeof updateClientBody>;
export type CreateContactInput = z.infer<typeof createContactBody>;
export type UpdateContactInput = z.infer<typeof updateContactBody>;
export type UpsertCompanyInput = z.infer<typeof upsertCompanyBody>;
