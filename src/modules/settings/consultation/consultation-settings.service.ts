import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { MINIMUM_CONSULTATION_FEE } from "../../../config/constants";
import {
  consultationSettings,
  ConsultationSettings,
} from "../../../db/schema/consultation-settings";
import { consultationLocations } from "../../../db/schema/consultation-locations";
import { BadRequestError, NotFoundError } from "../../../utils/error/app-error";
import {
  CreateConsultationLocationBody,
  UpdateConsultationLocationBody,
  UpsertConsultationSettingsBody,
} from "./consultation-settings.validation";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";

const log = createModuleLogger("consultation-settings.service");

/**
 * Present a disabled fee structure as the one it behaves like.
 *
 * `waived_if_retainer` never waived anything — no code path anywhere acted on
 * it, so a firm carrying it has been billing exactly as `flat` all along. This
 * makes the read agree with what the money did, without a migration that would
 * erase which firms had asked for the feature.
 *
 * Deliberately a read-time coercion and not an `UPDATE`: when the waiver is
 * built for real, deleting this function restores every firm's original choice.
 */
const enabledFeeStructure = (
  raw: ConsultationSettings["feeStructure"],
): "flat" | "custom_per_case_type" | null =>
  raw == null ? null : raw === "custom_per_case_type" ? raw : "flat";

const toSettingsDTO = (row: ConsultationSettings) => ({
  organizationId: row.organizationId,
  chargesFee: row.chargesFee,
  defaultAmount: row.defaultAmount != null ? Number(row.defaultAmount) : null,
  feeStructure: enabledFeeStructure(row.feeStructure),
  // Only ever meaningful for the disabled waiver structure, so nothing can
  // legitimately hold one any more.
  waiverWindowDays: null,
  feeSchedule: row.feeSchedule,
  upfrontPercent: row.upfrontPercent,
  noShowPolicy: row.noShowPolicy,
  timezone: row.timezone,
  language: row.language,
  smsEnabled: row.smsEnabled,
  updatedAt: row.updatedAt,
});

/**
 * Resolve the firm's IANA timezone, defaulting to UTC when unset. Shared by
 * scheduling and business-logic code that must compute in the firm zone.
 */
export const getFirmTimezone = async (
  organizationId: string,
): Promise<string> => {
  const [row] = await db
    .select({ timezone: consultationSettings.timezone })
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);
  return row?.timezone ?? "UTC";
};

/**
 * Resolve the firm's BCP-47 display language, defaulting to English when unset.
 *
 * This is the language STAFF read, so it governs how issue prose is rendered
 * from `case_issues.templateKey` / `templateParams` at read time. It is not the
 * lead's language (`leads.language`), which governs client-facing messages.
 *
 * Rendering at read time — rather than storing prose — is what lets the AI
 * analysis cache stay content-addressed: facts are language-neutral, so two
 * firms reading in different languages still share one cached extraction.
 */
export const getFirmLanguage = async (
  organizationId: string,
): Promise<string> => {
  const [row] = await db
    .select({ language: consultationSettings.language })
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);
  return row?.language ?? "en";
};

export class ConsultationSettingsService {
  getSettings = async (organizationId: string) => {
    const [row] = await db
      .select()
      .from(consultationSettings)
      .where(eq(consultationSettings.organizationId, organizationId))
      .limit(1);

    if (!row) {
      // Sensible defaults when a firm hasn't configured fees yet.
      return {
        organizationId,
        chargesFee: false,
        defaultAmount: null,
        feeStructure: null,
        waiverWindowDays: null,
        feeSchedule: "full_upfront" as const,
        upfrontPercent: null,
        noShowPolicy: "forfeit" as const,
        timezone: "UTC",
        language: "en",
        smsEnabled: false,
        updatedAt: null,
      };
    }

    return toSettingsDTO(row);
  };

  upsertSettings = async (
    organizationId: string,
    body: UpsertConsultationSettingsBody,
  ) => {
    const chargesFee = body.chargesFee;
    const feeStructure = chargesFee ? body.feeStructure ?? null : null;

    if (chargesFee && body.defaultAmount != null && body.defaultAmount < MINIMUM_CONSULTATION_FEE) {
      throw new BadRequestError(`Minimum consultation fee amount is $${MINIMUM_CONSULTATION_FEE}.00`);
    }

    const values = {
      chargesFee,
      defaultAmount:
        chargesFee && body.defaultAmount != null
          ? String(body.defaultAmount)
          : null,
      feeStructure,
      // The waiver structure is disabled, so nothing can set a window. Written
      // rather than left alone so a firm that had one is cleared on next save.
      waiverWindowDays: null,
      ...(body.feeSchedule !== undefined
        ? {
            feeSchedule: body.feeSchedule,
            // Kept in lockstep with the schedule so the pair can never
            // contradict the table's CHECK: only `partial_upfront` carries a
            // deposit, and changing away from it clears the stale percentage.
            upfrontPercent:
              body.feeSchedule === "partial_upfront"
                ? body.upfrontPercent ?? null
                : null,
          }
        : {}),
      ...(body.noShowPolicy !== undefined
        ? { noShowPolicy: body.noShowPolicy }
        : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.language !== undefined ? { language: body.language } : {}),
      smsEnabled: body.smsEnabled ?? false,
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select()
      .from(consultationSettings)
      .where(eq(consultationSettings.organizationId, organizationId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(consultationSettings)
        .set(values)
        .where(eq(consultationSettings.organizationId, organizationId))
        .returning();

      await recordAuditEvent({
        action: "system.settings_changed",
        entityId: organizationId,
        organizationId,
        before: { settingType: "consultation" },
        after: { settingType: "consultation", ...values, updatedAt: undefined },
        onWriteFailure: "log",
      });
      log.action("settings.consultation_updated", { organizationId });

      return toSettingsDTO(updated);
    }

    const [created] = await db
      .insert(consultationSettings)
      .values({ organizationId, ...values })
      .returning();

    await recordAuditEvent({
      action: "system.settings_changed",
      entityId: organizationId,
      organizationId,
      after: { settingType: "consultation", ...values, updatedAt: undefined },
      onWriteFailure: "log",
    });
    log.action("settings.consultation_updated", { organizationId });

    return toSettingsDTO(created);
  };

  listLocations = async (organizationId: string, includeInactive = false) => {
    const condition = includeInactive
      ? eq(consultationLocations.organizationId, organizationId)
      : and(
          eq(consultationLocations.organizationId, organizationId),
          eq(consultationLocations.isActive, true),
        );

    return db
      .select()
      .from(consultationLocations)
      .where(condition)
      .orderBy(asc(consultationLocations.createdAt));
  };

  createLocation = async (
    organizationId: string,
    body: CreateConsultationLocationBody,
  ) => {
    const [created] = await db
      .insert(consultationLocations)
      .values({ organizationId, ...body })
      .returning();

    if (created) {
      await recordAuditEvent({
        action: "system.settings_changed",
        entityId: organizationId,
        organizationId,
        after: { settingType: "consultation_location", locationId: created.id, label: created.label },
        onWriteFailure: "log",
      });
      log.action("settings.consultation_updated", { organizationId, locationId: created.id });
    }

    return created;
  };

  updateLocation = async (
    organizationId: string,
    locationId: string,
    body: UpdateConsultationLocationBody,
  ) => {
    const [updated] = await db
      .update(consultationLocations)
      .set({ ...body, updatedAt: new Date() })
      .where(
        and(
          eq(consultationLocations.id, locationId),
          eq(consultationLocations.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundError("Consultation location not found");

    await recordAuditEvent({
      action: "system.settings_changed",
      entityId: organizationId,
      organizationId,
      after: { settingType: "consultation_location", locationId, ...body },
      onWriteFailure: "log",
    });
    log.action("settings.consultation_updated", { organizationId, locationId });

    return updated;
  };

  deleteLocation = async (organizationId: string, locationId: string) => {
    const [deleted] = await db
      .delete(consultationLocations)
      .where(
        and(
          eq(consultationLocations.id, locationId),
          eq(consultationLocations.organizationId, organizationId),
        ),
      )
      .returning();

    if (!deleted) throw new NotFoundError("Consultation location not found");

    await recordAuditEvent({
      action: "system.settings_changed",
      entityId: organizationId,
      organizationId,
      before: { settingType: "consultation_location", locationId, label: deleted.label },
      onWriteFailure: "log",
    });
    log.action("settings.consultation_updated", { organizationId, locationId });

    return deleted;
  };
}
