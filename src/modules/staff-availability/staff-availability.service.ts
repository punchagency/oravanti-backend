import { and, asc, desc, eq, gte, lte, ne } from "drizzle-orm";
import { db } from "../../db/client";
import { createModuleLogger } from "../../lib/logging/log";
import {
  staffAvailability,
  staffAvailabilityBreaks,
  staffAvailabilityOverrides,
} from "../../db/schema/staff-availability";
import { leaveRequests } from "../../db/schema/leave-requests";
import { staff } from "../../db/schema/staff";
import { ConflictError, NotFoundError } from "../../utils/error/app-error";
import {
  CreateOverrideBody,
  CreateTimeOffBody,
  SetBreaksBody,
  SetWeeklyAvailabilityBody,
  UpdateOverrideBody,
  UpdateTimeOffBody,
} from "./staff-availability.validation";

const log = createModuleLogger("staff-availability.service");

export class StaffAvailabilityService {
  // Writes accept any staffId from admins, so confirm the target staff
  // actually belongs to the caller's organization before touching rows.
  private assertStaffInOrg = async (
    organizationId: string,
    staffId: string,
  ) => {
    const [found] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
      .limit(1);

    if (!found) throw new NotFoundError("Staff member not found");
  };

  private assertNoOverrideOnDate = async (
    organizationId: string,
    staffId: string,
    date: string,
    excludeOverrideId?: string,
  ) => {
    const conditions = [
      eq(staffAvailabilityOverrides.organizationId, organizationId),
      eq(staffAvailabilityOverrides.staffId, staffId),
      eq(staffAvailabilityOverrides.date, date),
    ];
    if (excludeOverrideId) {
      conditions.push(ne(staffAvailabilityOverrides.id, excludeOverrideId));
    }

    const [existing] = await db
      .select({ id: staffAvailabilityOverrides.id })
      .from(staffAvailabilityOverrides)
      .where(and(...conditions))
      .limit(1);

    if (existing) {
      throw new ConflictError("An override already exists for this date");
    }
  };

  private assertNoTimeOffOverlap = async (
    organizationId: string,
    staffId: string,
    startDate: string,
    endDate: string,
    excludeTimeOffId?: string,
  ) => {
    const conditions = [
      eq(leaveRequests.organizationId, organizationId),
      eq(leaveRequests.staffId, staffId),
      ne(leaveRequests.status, "rejected"),
      lte(leaveRequests.startDate, endDate),
      gte(leaveRequests.endDate, startDate),
    ];
    if (excludeTimeOffId) {
      conditions.push(ne(leaveRequests.id, excludeTimeOffId));
    }

    const [existing] = await db
      .select({ id: leaveRequests.id })
      .from(leaveRequests)
      .where(and(...conditions))
      .limit(1);

    if (existing) {
      throw new ConflictError("This period overlaps an existing time-off entry");
    }
  };

  getAvailability = async (organizationId: string, staffId: string) => {
    const scope = (table: typeof staffAvailability | typeof staffAvailabilityBreaks | typeof staffAvailabilityOverrides | typeof leaveRequests) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.staffId, staffId),
      );

    const [windows, breaks, overrides, timeOff] = await Promise.all([
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
      db
        .select()
        .from(leaveRequests)
        .where(scope(leaveRequests))
        .orderBy(desc(leaveRequests.startDate)),
    ]);

    return { windows, breaks, overrides, timeOff };
  };

  setWeeklyAvailability = async (
    organizationId: string,
    staffId: string,
    body: SetWeeklyAvailabilityBody,
  ) => {
    await this.assertStaffInOrg(organizationId, staffId);

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

      const result = await tx
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

      log.action("staff_availability.updated", { staffId, windowCount: result.length });

      return result;
    });
  };

  setBreaks = async (
    organizationId: string,
    staffId: string,
    body: SetBreaksBody,
  ) => {
    await this.assertStaffInOrg(organizationId, staffId);

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

      const result = await tx
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

      log.action("staff_availability.updated", { staffId, breakCount: result.length });

      return result;
    });
  };

  createOverride = async (
    organizationId: string,
    staffId: string,
    body: CreateOverrideBody,
  ) => {
    await this.assertStaffInOrg(organizationId, staffId);
    await this.assertNoOverrideOnDate(organizationId, staffId, body.date);

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
    log.action("staff_availability.blocked", { staffId, overrideId: created.id, date: body.date, type: body.type });
    return created;
  };

  updateOverride = async (
    organizationId: string,
    staffId: string,
    overrideId: string,
    body: UpdateOverrideBody,
  ) => {
    await this.assertNoOverrideOnDate(
      organizationId,
      staffId,
      body.date,
      overrideId,
    );

    const [updated] = await db
      .update(staffAvailabilityOverrides)
      .set({
        date: body.date,
        type: body.type,
        startTime: body.type === "custom_hours" ? body.startTime : null,
        endTime: body.type === "custom_hours" ? body.endTime : null,
        reason: body.reason ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(staffAvailabilityOverrides.id, overrideId),
          eq(staffAvailabilityOverrides.organizationId, organizationId),
          eq(staffAvailabilityOverrides.staffId, staffId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundError("Availability override not found");
    return updated;
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

  createTimeOff = async (
    organizationId: string,
    staffId: string,
    body: CreateTimeOffBody,
  ) => {
    await this.assertStaffInOrg(organizationId, staffId);
    await this.assertNoTimeOffOverlap(
      organizationId,
      staffId,
      body.startDate,
      body.endDate,
    );

    // Admin-created time off takes effect immediately; pending/rejected are
    // reserved for the future staff request flow.
    const [created] = await db
      .insert(leaveRequests)
      .values({
        organizationId,
        staffId,
        type: body.type,
        startDate: body.startDate,
        endDate: body.endDate,
        status: "approved",
        reason: body.reason,
      })
      .returning();
    log.action("staff_availability.blocked", { staffId, timeOffId: created.id, startDate: body.startDate, endDate: body.endDate });
    return created;
  };

  updateTimeOff = async (
    organizationId: string,
    staffId: string,
    timeOffId: string,
    body: UpdateTimeOffBody,
  ) => {
    await this.assertNoTimeOffOverlap(
      organizationId,
      staffId,
      body.startDate,
      body.endDate,
      timeOffId,
    );

    const [updated] = await db
      .update(leaveRequests)
      .set({
        type: body.type,
        startDate: body.startDate,
        endDate: body.endDate,
        reason: body.reason ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(leaveRequests.id, timeOffId),
          eq(leaveRequests.organizationId, organizationId),
          eq(leaveRequests.staffId, staffId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundError("Time-off entry not found");
    return updated;
  };

  deleteTimeOff = async (
    organizationId: string,
    staffId: string,
    timeOffId: string,
  ) => {
    const [deleted] = await db
      .delete(leaveRequests)
      .where(
        and(
          eq(leaveRequests.id, timeOffId),
          eq(leaveRequests.organizationId, organizationId),
          eq(leaveRequests.staffId, staffId),
        ),
      )
      .returning();

    if (!deleted) throw new NotFoundError("Time-off entry not found");
    return deleted;
  };
}
