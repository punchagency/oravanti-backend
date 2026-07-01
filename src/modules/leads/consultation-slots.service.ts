import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/client";
import { consultations } from "../../db/schema/consultations";
import { StaffAvailabilityService } from "../staff-availability/staff-availability.service";

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
const toEpoch = (dateStr: string, time: string) => {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return new Date(`${dateStr}T${normalized}Z`).getTime();
};

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
 * Times are treated as wall-clock UTC. Only future slots are returned.
 */
export const generateConsultationSlots = async (
  organizationId: string,
  leadAttorneyId: string,
  options: GenerateSlotsOptions,
): Promise<ConsultationSlot[]> => {
  const days = options.days ?? 14;
  const durationMs = options.durationMinutes * 60_000;
  const now = Date.now();

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

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const day = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate() + dayOffset,
      ),
    );
    const dateStr = day.toISOString().slice(0, 10);
    const weekday = day.getUTCDay();

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
      const windowEnd = toEpoch(dateStr, window.endTime);
      let cursor = toEpoch(dateStr, window.startTime);

      while (cursor + durationMs <= windowEnd) {
        const slotStart = cursor;
        const slotEnd = cursor + durationMs;
        cursor += durationMs;

        if (slotStart < now) continue;

        const hitsBreak = dayBreaks.some((b) =>
          overlaps(
            slotStart,
            slotEnd,
            toEpoch(dateStr, b.startTime),
            toEpoch(dateStr, b.endTime),
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
