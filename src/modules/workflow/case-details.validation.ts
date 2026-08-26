import { z } from "zod";
import { caseMilestoneEnum } from "../../db/schema/case-milestones";
import { caseFormRoleEnum, caseFormStatusEnum } from "../../db/schema/case-forms";
import {
  filingTrackEnum,
  petitionerStatusEnum,
  preferenceCategoryEnum,
  relationshipCategoryEnum,
  naturalizationTrackEnum,
} from "../../db/schema/immigration-case-details";
import { defendantTypeEnum } from "../../db/schema/personal-injury-case-details";

/**
 * Request schemas for the two practice-area extension tables.
 *
 * Same two rules as cases.validation.ts: enum values come from the Drizzle
 * schema rather than being retyped, and every body is `.strict()` — these
 * patches are spread straight into `.set()`, so a passthrough schema would let
 * a request write `organizationId` and move the row to another firm.
 */

/** `YYYY-MM-DD` — these are `date` columns, not timestamps. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format");

/** A clearable date field: a value sets it, `null` clears it, absent leaves it. */
const optionalDate = isoDate.nullable().optional();

export const caseIdParams = z.object({ caseId: z.string().uuid() });

// ── Immigration ────────────────────────────────────────────────────────────

export const upsertImmigrationDetailsBody = z
  .object({
    filingTrack: z.enum(filingTrackEnum.enumValues).nullable().optional(),

    // § 1.1 eligibility. Setting an input recomputes `filingTrack` and
    // `preferenceCategory` unless `filingTrackIsManual` is on.
    petitionerStatus: z.enum(petitionerStatusEnum.enumValues).nullable().optional(),
    relationshipCategory: z.enum(relationshipCategoryEnum.enumValues).nullable().optional(),
    preferenceCategory: z.enum(preferenceCategoryEnum.enumValues).nullable().optional(),
    filingTrackIsManual: z.boolean().optional(),
    countryOfChargeability: z.string().trim().min(1).max(64).nullable().optional(),
    naturalizationTrack: z.enum(naturalizationTrackEnum.enumValues).nullable().optional(),

    lprDate: optionalDate,
    eligibilityDate: optionalDate,
    earliestFilingDate: optionalDate,
    priorityDate: optionalDate,
    // Attorney judgement, like `mandamusEligible` above. Setting it opens the
    // I-485 package on a sequential matter, so it re-runs materialization.
    priorityDateIsCurrent: z.boolean().optional(),
    priorityDateIsManual: z.boolean().optional(),

    gmcRiskFlag: z.boolean().optional(),
    // Attorney judgement only. `computeMandamusCandidacy` produces figures to
    // read, never this flag — see mandamus.service.ts.
    mandamusEligible: z.boolean().nullable().optional(),
    isConditionalResidence: z.boolean().optional(),

    rfeIssuedDate: optionalDate,
    rfeDeadline: optionalDate,

    /*
      § 1.5 pitfall inputs.

      Each is read by exactly one named rule in `aos-validation.service.ts` and
      surfaced on the Checks card. They are listed here because this body is
      `.strict()` — the columns and the panel fields both existed while the
      validator did not know them, so every save from the immigration panel was
      rejected wholesale with `unrecognized_keys`, taking the rest of the
      patch down with it.
    */
    beneficiaryStatusExpirationDate: optionalDate,
    employmentStartDate: optionalDate,
    hasWorkAuthorization: z.boolean().optional(),
    /** Whole cents. Money is never a float, and never negative. */
    sponsorIncomeCents: z.number().int().min(0).nullable().optional(),
    sponsorHouseholdSize: z.number().int().min(1).max(50).nullable().optional(),
    /** Two-letter state code — the poverty-guideline table is keyed by it. */
    sponsorState: z.string().trim().length(2).nullable().optional(),
    sponsorIsActiveDutyMilitary: z.boolean().optional(),
    i693SignedDate: optionalDate,

    usAttorneyServedDate: optionalDate,
    agServedDate: optionalDate,
    agencyHeadServedDate: optionalDate,
    serviceCompletedDate: optionalDate,
    demandLetterSentDate: optionalDate,
    rulingDate: optionalDate,
    closureType: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" })
  .refine(
    (body) =>
      !body.rfeIssuedDate || !body.rfeDeadline || body.rfeDeadline > body.rfeIssuedDate,
    {
      // A deadline on or before the issue date yields no reminder schedule at
      // all (`rfeReminderSchedule` returns []), which would look like the hook
      // silently failing. Reject the typo instead.
      message: "rfeDeadline must be after rfeIssuedDate",
      path: ["rfeDeadline"],
    },
  );

// ── Personal injury ────────────────────────────────────────────────────────

export const upsertPersonalInjuryDetailsBody = z
  .object({
    incidentDate: isoDate.optional(),
    defendantType: z.enum(defendantTypeEnum.enumValues).optional(),
    isMinorPlaintiff: z.boolean().optional(),

    statuteOfLimitationsDate: optionalDate,
    solTollingNotes: z.string().trim().nullable().optional(),
    governmentNoticeDeadline: optionalDate,

    mmiDate: optionalDate,
    mmiConfirmedBy: z.string().trim().min(1).nullable().optional(),
    treatmentGapFlag: z.boolean().optional(),
    demandSentDate: optionalDate,

    defendantAnswerDate: optionalDate,
    msjFiledDate: optionalDate,
    mediationScheduledDate: optionalDate,
    trialDate: optionalDate,
    verdictDate: optionalDate,
    fundsReceivedDate: optionalDate,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/**
 * Recording what the agency did.
 *
 * Deliberately its own endpoint rather than a field on the immigration-details
 * patch: writing one of these dates also writes the milestone row, the calendar
 * event and the audit entry, and re-resolves the case's due dates. See
 * `case-milestone.service.ts`.
 */
export const recordCaseMilestoneBody = z
  .object({
    milestone: z.enum(caseMilestoneEnum.enumValues),
    occurredOn: isoDate,
    /** The I-797C or other notice this date was read off. */
    noticeNumber: z.string().trim().min(1).max(40).nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/**
 * A form code, e.g. "I-485" or "I-130A".
 *
 * Validated by shape rather than against an enum, deliberately: a package
 * carries forms that are not themselves a kind of case, firms file waivers and
 * supplements this codebase has never heard of, and `form_editions.form_code`
 * is free text for the same reason. The pattern is what stops a typo becoming
 * a new form.
 */
export const formCodeParam = z.object({
  caseId: z.string().uuid(),
  formCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{1,4}-\d{1,4}[A-Z]?$/, "Expected a form code like I-485 or I-130A"),
});

/** What may be set on one form of a matter's filing package. */
export const updateCaseFormBody = z
  .object({
    role: z.enum(caseFormRoleEnum.enumValues).optional(),
    status: z.enum(caseFormStatusEnum.enumValues).optional(),
    editionDate: isoDate.nullable().optional(),
    filedDate: isoDate.nullable().optional(),
    receiptNumber: z.string().trim().min(1).max(40).nullable().optional(),
    /** Whole cents. Money is never a float, and never negative. */
    feeCents: z.number().int().min(0).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/**
 * Which forms to set up. Omitted means the standard adjustment package.
 *
 * A firm filing something non-standard names its own list rather than being
 * given six rows it then has to delete.
 */
export const initializeCaseFormsBody = z
  .object({
    forms: z
      .array(
        z.object({
          formCode: z
            .string()
            .trim()
            .regex(/^[A-Z]{1,4}-\d{1,4}[A-Z]?$/, "Expected a form code like I-485 or I-130A"),
          role: z.enum(caseFormRoleEnum.enumValues).default("core"),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
  })
  .strict();
