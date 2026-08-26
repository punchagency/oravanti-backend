import { describe, expect, it } from "@jest/globals";
import { getTableColumns } from "drizzle-orm";
import { immigrationCaseDetails } from "../../../src/db/schema/immigration-case-details";
import { personalInjuryCaseDetails } from "../../../src/db/schema/personal-injury-case-details";
import {
  upsertImmigrationDetailsBody,
  upsertPersonalInjuryDetailsBody,
} from "../../../src/modules/workflow/case-details.validation";

/*
  The extension-table request bodies are `.strict()`, which is deliberate — they
  are spread straight into `.set()`, so a passthrough schema would let a request
  write `organizationId` and move the row to another firm.

  The cost of `.strict()` is that a column the panel writes but the validator
  has never heard of does not fail on that one field. Zod rejects the whole body
  with `unrecognized_keys`, so an unrelated edit to the priority date is thrown
  away too, and the only symptom is a 400 naming keys nobody looked for. That is
  exactly what happened to the eight § 1.5 pitfall inputs: the columns existed,
  the panel wrote them, and every immigration-details save had been failing.

  So the two are pinned together here. Adding a column now forces a decision:
  declare it in the validator, or say in `WRITTEN_ELSEWHERE` why it is not
  writable through this endpoint.
*/

/** Never writable through a patch, on any table. */
const STRUCTURAL = ["id", "caseId", "organizationId", "createdAt", "updatedAt"];

/**
 * Columns a patch deliberately cannot reach, and what writes them instead.
 *
 * Each entry is a claim that has to stay true — if one of these ever becomes an
 * ordinary field, it belongs in the validator and not here.
 */
const WRITTEN_ELSEWHERE: Record<string, string> = {
  // `case_milestones` is the source of truth; these are its denormalized read
  // path. Only `recordCaseMilestone` writes them, so that the milestone row,
  // the calendar event and the audit entry are never skipped.
  receiptDate: "recordCaseMilestone",
  biometricsAppointmentDate: "recordCaseMilestone",
  interviewScheduledDate: "recordCaseMilestone",
  decisionDate: "recordCaseMilestone",
  cardValidTo: "recordCaseMilestone",
  greenCardExpirationDate: "recordCaseMilestone",

  // A jsonb list of trips, edited through its own endpoint rather than as a
  // whole-array overwrite on every details save.
  travelWhilePending: "the travel-history endpoint",
};

const writableColumns = (table: Parameters<typeof getTableColumns>[0]) =>
  Object.keys(getTableColumns(table)).filter((name) => !STRUCTURAL.includes(name));

const declaredKeys = (schema: { _def: unknown }) => {
  // Both bodies are a `ZodObject` wrapped in `.strict().refine(...)`, so the
  // shape is reached through the effects rather than off the top level.
  let node = schema as { _def: { schema?: unknown; shape?: unknown } };
  while (node._def?.schema) node = node._def.schema as typeof node;
  return Object.keys((node as unknown as { shape: Record<string, unknown> }).shape);
};

describe("every writable column is reachable through its request body", () => {
  it("holds for immigration details", () => {
    const declared = new Set(declaredKeys(upsertImmigrationDetailsBody));

    const unreachable = writableColumns(immigrationCaseDetails).filter(
      (name) => !declared.has(name) && !(name in WRITTEN_ELSEWHERE),
    );

    expect(unreachable).toStrictEqual([]);
  });

  it("holds for personal-injury details", () => {
    const declared = new Set(declaredKeys(upsertPersonalInjuryDetailsBody));

    const unreachable = writableColumns(personalInjuryCaseDetails).filter(
      (name) => !declared.has(name) && !(name in WRITTEN_ELSEWHERE),
    );

    expect(unreachable).toStrictEqual([]);
  });

  it("declares nothing that is not a column", () => {
    // The other direction: a validator key with no column behind it passes
    // validation and then silently does nothing on `.set()`.
    const columns = new Set(Object.keys(getTableColumns(immigrationCaseDetails)));

    expect(declaredKeys(upsertImmigrationDetailsBody).filter((k) => !columns.has(k))).toStrictEqual(
      [],
    );
  });
});

describe("the § 1.5 pitfall inputs a save actually carries", () => {
  /*
    The regression itself, stated in the vocabulary of the bug report: this is
    the body the immigration panel sends, and it must be accepted.
  */
  it("accepts the sponsor and work-authorization fields together", () => {
    const result = upsertImmigrationDetailsBody.safeParse({
      beneficiaryStatusExpirationDate: "2026-11-30",
      employmentStartDate: "2026-01-15",
      hasWorkAuthorization: true,
      sponsorIncomeCents: 6_240_000,
      sponsorHouseholdSize: 4,
      sponsorState: "CA",
      sponsorIsActiveDutyMilitary: true,
      i693SignedDate: "2026-02-01",
      isConditionalResidence: true,
    });

    expect(result.success).toBe(true);
  });

  it("still refuses a key that is not a column", () => {
    const result = upsertImmigrationDetailsBody.safeParse({
      priorityDate: "2024-03-01",
      organizationId: "another-firm",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a state that is not a two-letter code", () => {
    // The poverty-guideline table is keyed by the code, so "California" would
    // match no row and the affidavit-of-support rule would silently say nothing.
    expect(upsertImmigrationDetailsBody.safeParse({ sponsorState: "California" }).success).toBe(
      false,
    );
  });

  it("refuses negative sponsor income", () => {
    expect(upsertImmigrationDetailsBody.safeParse({ sponsorIncomeCents: -1 }).success).toBe(false);
  });
});
