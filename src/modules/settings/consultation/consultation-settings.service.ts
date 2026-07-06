import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import {
  consultationSettings,
  ConsultationSettings,
} from "../../../db/schema/consultation-settings";
import { consultationLocations } from "../../../db/schema/consultation-locations";
import { NotFoundError } from "../../../utils/error/app-error";
import {
  CreateConsultationLocationBody,
  UpdateConsultationLocationBody,
  UpsertConsultationSettingsBody,
} from "./consultation-settings.validation";

const toSettingsDTO = (row: ConsultationSettings) => ({
  organizationId: row.organizationId,
  chargesFee: row.chargesFee,
  defaultAmount: row.defaultAmount != null ? Number(row.defaultAmount) : null,
  feeStructure: row.feeStructure,
  waiverWindowDays: row.waiverWindowDays,
  timezone: row.timezone,
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
        timezone: "UTC",
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

    const values = {
      chargesFee,
      defaultAmount:
        chargesFee && body.defaultAmount != null
          ? String(body.defaultAmount)
          : null,
      feeStructure,
      waiverWindowDays:
        chargesFee && feeStructure === "waived_if_retainer"
          ? body.waiverWindowDays ?? null
          : null,
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
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
      return toSettingsDTO(updated);
    }

    const [created] = await db
      .insert(consultationSettings)
      .values({ organizationId, ...values })
      .returning();
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
    return deleted;
  };
}
