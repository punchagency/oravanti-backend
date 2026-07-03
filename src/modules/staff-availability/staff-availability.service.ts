import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  staffAvailability,
  staffAvailabilityBreaks,
  staffAvailabilityOverrides,
} from "../../db/schema/staff-availability";
import { NotFoundError } from "../../utils/error/app-error";
import {
  CreateOverrideBody,
  SetBreaksBody,
  SetWeeklyAvailabilityBody,
} from "./staff-availability.validation";

export class StaffAvailabilityService {
  getAvailability = async (organizationId: string, staffId: string) => {
    const scope = (table: typeof staffAvailability | typeof staffAvailabilityBreaks | typeof staffAvailabilityOverrides) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.staffId, staffId),
      );

    const [windows, breaks, overrides] = await Promise.all([
      db
        .select()
        .from(staffAvailability)
        .where(scope(staffAvailability))
        .orderBy(
          asc(staffAvailability.dayOfWeek),
          asc(staffAvailability.startTime),
        ),
      db
        .select()
        .from(staffAvailabilityBreaks)
        .where(scope(staffAvailabilityBreaks))
        .orderBy(
          asc(staffAvailabilityBreaks.dayOfWeek),
          asc(staffAvailabilityBreaks.startTime),
        ),
      db
        .select()
        .from(staffAvailabilityOverrides)
        .where(scope(staffAvailabilityOverrides))
        .orderBy(asc(staffAvailabilityOverrides.date)),
    ]);

    return { windows, breaks, overrides };
  };

  setWeeklyAvailability = async (
    organizationId: string,
    staffId: string,
    body: SetWeeklyAvailabilityBody,
  ) => {
    return db.transaction(async (tx) => {
      await tx
        .delete(staffAvailability)
        .where(
          and(
            eq(staffAvailability.organizationId, organizationId),
            eq(staffAvailability.staffId, staffId),
          ),
        );

      if (body.windows.length > 0) {
        await tx.insert(staffAvailability).values(
          body.windows.map((w) => ({
            organizationId,
            staffId,
            dayOfWeek: w.dayOfWeek,
            startTime: w.startTime,
            endTime: w.endTime,
          })),
        );
      }

      return tx
        .select()
        .from(staffAvailability)
        .where(
          and(
            eq(staffAvailability.organizationId, organizationId),
            eq(staffAvailability.staffId, staffId),
          ),
        )
        .orderBy(
          asc(staffAvailability.dayOfWeek),
          asc(staffAvailability.startTime),
        );
    });
  };

  setBreaks = async (
    organizationId: string,
    staffId: string,
    body: SetBreaksBody,
  ) => {
    return db.transaction(async (tx) => {
      await tx
        .delete(staffAvailabilityBreaks)
        .where(
          and(
            eq(staffAvailabilityBreaks.organizationId, organizationId),
            eq(staffAvailabilityBreaks.staffId, staffId),
          ),
        );

      if (body.breaks.length > 0) {
        await tx.insert(staffAvailabilityBreaks).values(
          body.breaks.map((b) => ({
            organizationId,
            staffId,
            dayOfWeek: b.dayOfWeek,
            startTime: b.startTime,
            endTime: b.endTime,
            label: b.label,
          })),
        );
      }

      return tx
        .select()
        .from(staffAvailabilityBreaks)
        .where(
          and(
            eq(staffAvailabilityBreaks.organizationId, organizationId),
            eq(staffAvailabilityBreaks.staffId, staffId),
          ),
        )
        .orderBy(
          asc(staffAvailabilityBreaks.dayOfWeek),
          asc(staffAvailabilityBreaks.startTime),
        );
    });
  };

  createOverride = async (
    organizationId: string,
    staffId: string,
    body: CreateOverrideBody,
  ) => {
    const [created] = await db
      .insert(staffAvailabilityOverrides)
      .values({
        organizationId,
        staffId,
        date: body.date,
        type: body.type,
        startTime: body.type === "custom_hours" ? body.startTime : null,
        endTime: body.type === "custom_hours" ? body.endTime : null,
        reason: body.reason,
      })
      .returning();
    return created;
  };

  deleteOverride = async (
    organizationId: string,
    staffId: string,
    overrideId: string,
  ) => {
    const [deleted] = await db
      .delete(staffAvailabilityOverrides)
      .where(
        and(
          eq(staffAvailabilityOverrides.id, overrideId),
          eq(staffAvailabilityOverrides.organizationId, organizationId),
          eq(staffAvailabilityOverrides.staffId, staffId),
        ),
      )
      .returning();

    if (!deleted) throw new NotFoundError("Availability override not found");
    return deleted;
  };
}
