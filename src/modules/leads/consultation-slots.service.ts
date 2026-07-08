import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../../db/client";
import { consultations } from "../../db/schema/consultations";
import { StaffAvailabilityService } from "../staff-availability/staff-availability.service";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";
import { dayjs, wallClockToEpoch } from "../../utils/date";

export type ConsultationSlot = {
  start: string; // ISO 8601
  end: string; // ISO 8601
};

export type GenerateSlotsOptions = {
  fromDate?: Date;
  days?: number;
  durationMinutes: number;
};

const availabilityService = new StaffAvailabilityService();

// Times come from Postgres `time` columns as "HH:MM:SS" (sometimes "HH:MM").
// A window like 09:00–17:00 is wall-clock in the *firm's* timezone, so it is
// converted to a UTC epoch using that zone (DST-safe) rather than a hardcoded Z.
const toEpoch = (dateStr: string, time: string, tz: string) =>
  wallClockToEpoch(dateStr, time, tz);

const overlaps = (
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
) => aStart < bEnd && bStart < aEnd;

/**
 * Generates bookable consultation slots from the lead attorney's availability
 * (Plan 02): recurring weekly windows minus breaks, with date overrides
 * (closed / custom hours) applied, and existing booked consultations removed.
 * Availability windows are wall-clock in the firm's timezone and converted to
 * UTC instants (DST-safe). Only future slots are returned.
 */
export const generateConsultationSlots = async (
  organizationId: string,
  leadAttorneyId: string,
  options: GenerateSlotsOptions,
): Promise<ConsultationSlot[]> => {
  const days = options.days ?? 14;
  const durationMs = options.durationMinutes * 60_000;
  const now = Date.now();
  const tz = await getFirmTimezone(organizationId);

  const { windows, breaks, overrides } =
    await availabilityService.getAvailability(organizationId, leadAttorneyId);

  if (!windows.length && !overrides.length) return [];

  // Existing booked intervals for this attorney, to avoid double-booking.
  const booked = await db
    .select({
      scheduledAt: consultations.scheduledAt,
      duration: consultations.duration,
    })
    .from(consultations)
    .where(
      and(
        eq(consultations.organizationId, organizationId),
        eq(consultations.leadAttorneyId, leadAttorneyId),
        isNotNull(consultations.scheduledAt),
        inArray(consultations.status, ["scheduled", "in_progress"]),
      ),
    );

  const bookedIntervals = booked
    .filter((b) => b.scheduledAt)
    .map((b) => {
      const start = b.scheduledAt!.getTime();
      return [start, start + b.duration * 60_000] as const;
    });

  const slots: ConsultationSlot[] = [];
  const base = options.fromDate ?? new Date();
  // Iterate calendar days in the firm's timezone so weekday/date bucketing
  // matches the firm's local calendar (not UTC's).
  const baseDay = dayjs.utc(base).tz(tz).startOf("day");

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const day = baseDay.add(dayOffset, "day");
    const dateStr = day.format("YYYY-MM-DD");
    const weekday = day.day();

    const override = overrides.find((o) => o.date === dateStr);

    let dayWindows: { startTime: string; endTime: string }[];
    let applyBreaks = true;

    if (override) {
      if (override.type === "closed" || !override.startTime || !override.endTime)
        continue;
      // An override defines the exact hours for that date; breaks don't apply.
      dayWindows = [
        { startTime: override.startTime, endTime: override.endTime },
      ];
      applyBreaks = false;
    } else {
      dayWindows = windows.filter((w) => w.dayOfWeek === weekday);
    }

    if (!dayWindows.length) continue;

    const dayBreaks = applyBreaks
      ? breaks.filter((b) => b.dayOfWeek === weekday)
      : [];

    for (const window of dayWindows) {
      const windowEnd = toEpoch(dateStr, window.endTime, tz);
      let cursor = toEpoch(dateStr, window.startTime, tz);

      while (cursor + durationMs <= windowEnd) {
        const slotStart = cursor;
        const slotEnd = cursor + durationMs;
        cursor += durationMs;

        if (slotStart < now) continue;

        const hitsBreak = dayBreaks.some((b) =>
          overlaps(
            slotStart,
            slotEnd,
            toEpoch(dateStr, b.startTime, tz),
            toEpoch(dateStr, b.endTime, tz),
          ),
        );
        if (hitsBreak) continue;

        const isBooked = bookedIntervals.some(([bStart, bEnd]) =>
          overlaps(slotStart, slotEnd, bStart, bEnd),
        );
        if (isBooked) continue;

        slots.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
        });
      }
    }
  }

  return slots;
};

export type TimeConflictCheck = {
  outsideAvailability: boolean;
  overlapsBooking: boolean;
  warnings: string[];
};

/**
 * Non-blocking conflict check for a specific proposed time (used by urgent
 * scheduling, which lets an admin book outside the normal slot queue). Reuses
 * the same availability windows/breaks/overrides and booked-interval logic as
 * slot generation, but for an arbitrary start rather than aligned slots.
 */
export const checkAttorneyTimeConflicts = async (
  organizationId: string,
  leadAttorneyId: string,
  start: Date,
  durationMinutes: number,
  excludeConsultationId?: string,
): Promise<TimeConflictCheck> => {
  const startMs = start.getTime();
  const endMs = startMs + durationMinutes * 60_000;
  const tz = await getFirmTimezone(organizationId);
  // Evaluate the proposed time against the firm's local calendar day/weekday.
  const startInTz = dayjs.utc(start).tz(tz);
  const dateStr = startInTz.format("YYYY-MM-DD");
  const weekday = startInTz.day();

  const { windows, breaks, overrides } =
    await availabilityService.getAvailability(organizationId, leadAttorneyId);

  const override = overrides.find((o) => o.date === dateStr);
  let dayWindows: { startTime: string; endTime: string }[];
  let applyBreaks = true;
  if (override) {
    dayWindows =
      override.type === "closed" || !override.startTime || !override.endTime
        ? []
        : [{ startTime: override.startTime, endTime: override.endTime }];
    applyBreaks = false;
  } else {
    dayWindows = windows.filter((w) => w.dayOfWeek === weekday);
  }

  const withinWindow = dayWindows.some(
    (w) =>
      toEpoch(dateStr, w.startTime, tz) <= startMs &&
      endMs <= toEpoch(dateStr, w.endTime, tz),
  );
  const dayBreaks = applyBreaks
    ? breaks.filter((b) => b.dayOfWeek === weekday)
    : [];
  const hitsBreak = dayBreaks.some((b) =>
    overlaps(
      startMs,
      endMs,
      toEpoch(dateStr, b.startTime, tz),
      toEpoch(dateStr, b.endTime, tz),
    ),
  );
  const outsideAvailability = !withinWindow || hitsBreak;

  const booked = await db
    .select({
      scheduledAt: consultations.scheduledAt,
      duration: consultations.duration,
    })
    .from(consultations)
    .where(
      and(
        eq(consultations.organizationId, organizationId),
        eq(consultations.leadAttorneyId, leadAttorneyId),
        isNotNull(consultations.scheduledAt),
        inArray(consultations.status, ["scheduled", "in_progress"]),
        excludeConsultationId
          ? ne(consultations.id, excludeConsultationId)
          : undefined,
      ),
    );

  const overlapsBooking = booked
    .filter((b) => b.scheduledAt)
    .some((b) => {
      const bStart = b.scheduledAt!.getTime();
      return overlaps(startMs, endMs, bStart, bStart + b.duration * 60_000);
    });

  const warnings: string[] = [];
  if (outsideAvailability)
    warnings.push(
      "The selected time is outside the attorney's available hours.",
    );
  if (overlapsBooking)
    warnings.push(
      "The selected time overlaps another booked consultation for this attorney.",
    );

  return { outsideAvailability, overlapsBooking, warnings };
};
