import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/client";
import { member } from "../../../db/schema/auth-schema";
import { consultations } from "../../../db/schema/consultations";
import {
  feeAgreementSettings,
  FeeAgreementSettings,
} from "../../../db/schema/fee-agreement-settings";
import { leads } from "../../../db/schema/leads";
import { staff } from "../../../db/schema/staff";
import { createModuleLogger } from "../../../lib/logging/log";
import { BadRequestError } from "../../../utils/error/app-error";
import { recordAuditEvent } from "../../shared/audit.service";
import { listUserIdsWithGrant } from "../../shared/member-grants.service";
import { UpsertFeeAgreementSettingsBody } from "./fee-agreement-settings.validation";

const log = createModuleLogger("fee-agreement-settings.service");

/** The grant that makes someone eligible to sign on the firm's behalf. */
export const FEE_AGREEMENT_SIGN_GRANT = "fee_agreements:sign";

export type ResolvedFeeAgreementSettings = {
  organizationId: string;
  requiresFirmSignature: boolean;
  signingOrder: "client_first" | "firm_first";
  invoiceWaitsForFirmSignature: boolean;
  allowSignerOverride: boolean;
  defaultSignerStaffId: string | null;
  updatedAt: Date | null;
};

/**
 * What a firm that has never opened the settings tab gets. Kept next to the
 * column defaults it mirrors — a firm with no row and a firm with an untouched
 * row must behave identically, and they only do if these two agree.
 */
const FACTORY_DEFAULTS = {
  requiresFirmSignature: true,
  signingOrder: "client_first" as const,
  invoiceWaitsForFirmSignature: true,
  allowSignerOverride: true,
  defaultSignerStaffId: null,
};

const toDTO = (row: FeeAgreementSettings): ResolvedFeeAgreementSettings => ({
  organizationId: row.organizationId,
  requiresFirmSignature: row.requiresFirmSignature,
  signingOrder: row.signingOrder,
  invoiceWaitsForFirmSignature: row.invoiceWaitsForFirmSignature,
  allowSignerOverride: row.allowSignerOverride,
  defaultSignerStaffId: row.defaultSignerStaffId,
  updatedAt: row.updatedAt,
});

/**
 * Resolve a firm's fee-agreement signing settings, falling back to the factory
 * defaults when unset. Import this rather than querying the table — every
 * caller needs a fully-populated answer, none of them want to think about a
 * missing row, and the defaults belong in one place.
 */
export const getFeeAgreementSettings = async (
  organizationId: string,
): Promise<ResolvedFeeAgreementSettings> => {
  const [row] = await db
    .select()
    .from(feeAgreementSettings)
    .where(eq(feeAgreementSettings.organizationId, organizationId))
    .limit(1);

  return row
    ? toDTO(row)
    : { organizationId, ...FACTORY_DEFAULTS, updatedAt: null };
};

export type EligibleSigner = {
  staffId: string;
  userId: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
};

/**
 * The active staff who may sign on the firm's behalf.
 *
 * Resolved from real grants, never from `staff.role` or a job title: a firm can
 * rename its attorney role, fork it, or hand signing authority to a role group,
 * and a string comparison sees none of that. `staff.role` is explicitly a
 * best-effort display projection (see its comment in the schema).
 */
export const listEligibleSigners = async (
  organizationId: string,
): Promise<EligibleSigner[]> => {
  const holders = await listUserIdsWithGrant(
    organizationId,
    FEE_AGREEMENT_SIGN_GRANT,
  );
  if (holders.size === 0) return [];

  const rows = await db
    .select({
      staffId: staff.id,
      userId: staff.userId,
      firstName: staff.firstName,
      lastName: staff.lastName,
      jobTitle: staff.jobTitle,
      email: staff.orgEmail,
      fallbackEmail: staff.email,
    })
    .from(staff)
    .where(
      and(
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
        inArray(staff.userId, Array.from(holders)),
      ),
    )
    .orderBy(asc(staff.firstName), asc(staff.lastName));

  return rows.map((r) => ({
    staffId: r.staffId,
    // Narrowed by the `inArray` above — a staff row without a userId cannot
    // match a holder.
    userId: r.userId as string,
    name: `${r.firstName} ${r.lastName}`.trim(),
    jobTitle: r.jobTitle,
    email: r.email ?? r.fallbackEmail,
  }));
};

/**
 * Whether one staff member may sign for the firm. Takes the holder set so a
 * caller checking several candidates in a row (which is exactly what
 * `resolveDefaultFirmSigner` does) resolves the firm's roles once.
 */
const staffHoldsSignGrant = async (
  organizationId: string,
  staffId: string,
  holders: Set<string>,
): Promise<boolean> => {
  const [row] = await db
    .select({ userId: staff.userId, status: staff.status })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
    .limit(1);

  if (!row?.userId) return false;
  if (row.status !== "active") return false;
  return holders.has(row.userId);
};

export const assertStaffMaySign = async (
  organizationId: string,
  staffId: string,
): Promise<void> => {
  const holders = await listUserIdsWithGrant(
    organizationId,
    FEE_AGREEMENT_SIGN_GRANT,
  );
  if (!(await staffHoldsSignGrant(organizationId, staffId, holders))) {
    throw new BadRequestError(
      "That staff member is not permitted to sign fee agreements",
    );
  }
};

/**
 * Who signs for the firm on this lead's agreement, by default.
 *
 * The consultation attorney first — they are the person the client met and the
 * name already printed on the document. Then the firm's configured fallback,
 * then the owner, who holds every grant by construction and is therefore the
 * one candidate that cannot fail. Each candidate must actually hold
 * `fee_agreements:sign`; a firm that has narrowed its attorney role skips
 * straight past them rather than generating an agreement nobody can execute.
 *
 * Deliberately does not reuse the attorney lookup in
 * `assembleFeeAgreementDocument`: that one falls back to `leads.respondentId`
 * (who took the intake) under a column alias that says `assignedStaffId`, and
 * inheriting that here would quietly hand signing authority to whoever answered
 * the phone.
 */
export const resolveDefaultFirmSigner = async (
  organizationId: string,
  leadId: string,
): Promise<string> => {
  const holders = await listUserIdsWithGrant(
    organizationId,
    FEE_AGREEMENT_SIGN_GRANT,
  );

  const candidates: string[] = [];

  // 1. The attorney the consultation was booked with.
  const [lead] = await db
    .select({ consultationId: leads.consultationId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (lead?.consultationId) {
    const [consultation] = await db
      .select({ leadAttorneyId: consultations.leadAttorneyId })
      .from(consultations)
      .where(eq(consultations.id, lead.consultationId))
      .limit(1);
    if (consultation?.leadAttorneyId) candidates.push(consultation.leadAttorneyId);
  }

  // 2. The firm's configured fallback signer.
  const settings = await getFeeAgreementSettings(organizationId);
  if (settings.defaultSignerStaffId) {
    candidates.push(settings.defaultSignerStaffId);
  }

  // 3. The owner.
  const [owner] = await db
    .select({ staffId: staff.id })
    .from(member)
    .innerJoin(staff, eq(staff.userId, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.role, "owner"),
        eq(staff.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (owner?.staffId) candidates.push(owner.staffId);

  for (const staffId of candidates) {
    if (await staffHoldsSignGrant(organizationId, staffId, holders)) {
      return staffId;
    }
  }

  throw new BadRequestError(
    "No one at this firm is permitted to sign fee agreements. Grant the fee agreement signing permission to a role, or turn off the firm signature requirement in Firm settings.",
  );
};

export class FeeAgreementSettingsService {
  getSettings = (organizationId: string) =>
    getFeeAgreementSettings(organizationId);

  listEligibleSigners = (organizationId: string) =>
    listEligibleSigners(organizationId);

  upsertSettings = async (
    organizationId: string,
    body: UpsertFeeAgreementSettingsBody,
  ): Promise<ResolvedFeeAgreementSettings> => {
    if (body.defaultSignerStaffId) {
      await assertStaffMaySign(organizationId, body.defaultSignerStaffId);
    }

    // Every field conditional — see the note on the validation schema. A card
    // that saves one toggle must not reset the other four.
    const values = {
      ...(body.requiresFirmSignature !== undefined
        ? { requiresFirmSignature: body.requiresFirmSignature }
        : {}),
      ...(body.signingOrder !== undefined
        ? { signingOrder: body.signingOrder }
        : {}),
      ...(body.invoiceWaitsForFirmSignature !== undefined
        ? { invoiceWaitsForFirmSignature: body.invoiceWaitsForFirmSignature }
        : {}),
      ...(body.allowSignerOverride !== undefined
        ? { allowSignerOverride: body.allowSignerOverride }
        : {}),
      ...(body.defaultSignerStaffId !== undefined
        ? { defaultSignerStaffId: body.defaultSignerStaffId }
        : {}),
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select()
      .from(feeAgreementSettings)
      .where(eq(feeAgreementSettings.organizationId, organizationId))
      .limit(1);

    const row = existing
      ? (
          await db
            .update(feeAgreementSettings)
            .set(values)
            .where(eq(feeAgreementSettings.organizationId, organizationId))
            .returning()
        )[0]
      : (
          await db
            .insert(feeAgreementSettings)
            .values({ organizationId, ...values })
            .returning()
        )[0];

    await recordAuditEvent({
      action: "system.settings_changed",
      entityId: organizationId,
      organizationId,
      ...(existing ? { before: { settingType: "fee_agreement" } } : {}),
      after: { settingType: "fee_agreement", ...values, updatedAt: undefined },
      onWriteFailure: "log",
    });
    log.action("settings.fee_agreement_updated", { organizationId });

    return toDTO(row);
  };
}
