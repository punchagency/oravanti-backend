import { z } from "zod";

const timeStr = z
  .string()
  .regex(
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
    "Invalid time, expected HH:MM",
  );

const dayOfWeek = z.number().int().min(0).max(6);

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date, expected YYYY-MM-DD");

export const staffIdParamsSchema = z.object({
  staffId: z.string().uuid(),
});

export const overrideParamsSchema = z.object({
  staffId: z.string().uuid(),
  overrideId: z.string().uuid(),
});

export const timeOffParamsSchema = z.object({
  staffId: z.string().uuid(),
  timeOffId: z.string().uuid(),
});

// Rejects two ranges on the same day that overlap (including exact
// duplicates). Ranges are compared as HH:MM strings after sorting by start.
const addIntraDayOverlapIssues = (
  items: { dayOfWeek: number; startTime: string; endTime: string }[],
  ctx: z.RefinementCtx,
) => {
  const byDay = new Map<number, { index: number; startTime: string; endTime: string }[]>();
  items.forEach((item, index) => {
    const day = byDay.get(item.dayOfWeek) ?? [];
    day.push({ index, startTime: item.startTime, endTime: item.endTime });
    byDay.set(item.dayOfWeek, day);
  });

  for (const day of byDay.values()) {
    day.sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < day.length; i++) {
      if (day[i].startTime < day[i - 1].endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Time ranges on the same day must not overlap",
          path: [day[i].index, "startTime"],
        });
      }
    }
  }
};

const windowSchema = z
  .object({
    dayOfWeek,
    startTime: timeStr,
    endTime: timeStr,
  })
  .refine((w) => w.startTime < w.endTime, {
    message: "startTime must be before endTime",
    path: ["endTime"],
  });

export const setWeeklyAvailabilitySchema = z.object({
  windows: z
    .array(windowSchema)
    .superRefine(addIntraDayOverlapIssues),
});

const breakSchema = z
  .object({
    dayOfWeek,
    startTime: timeStr,
    endTime: timeStr,
    label: z.string().optional(),
  })
  .refine((b) => b.startTime < b.endTime, {
    message: "startTime must be before endTime",
    path: ["endTime"],
  });

export const setBreaksSchema = z.object({
  breaks: z
    .array(breakSchema)
    .superRefine(addIntraDayOverlapIssues),
});

export const createOverrideSchema = z
  .object({
    date: dateStr,
    type: z.enum(["closed", "custom_hours"]),
    startTime: timeStr.optional(),
    endTime: timeStr.optional(),
    reason: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type !== "custom_hours") return;

    if (!val.startTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startTime is required for custom hours",
        path: ["startTime"],
      });
    }
    if (!val.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endTime is required for custom hours",
        path: ["endTime"],
      });
    }
    if (val.startTime && val.endTime && val.startTime >= val.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startTime must be before endTime",
        path: ["endTime"],
      });
    }
  });

// Edits submit the full payload, so the update schema is identical.
export const updateOverrideSchema = createOverrideSchema;

const timeOffShape = z
  .object({
    type: z.enum(["annual", "sick", "emergency", "unpaid"]),
    startDate: dateStr,
    endDate: dateStr,
    reason: z.string().optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "startDate must be on or before endDate",
    path: ["endDate"],
  });

export const createTimeOffSchema = timeOffShape;
export const updateTimeOffSchema = timeOffShape;

export type SetWeeklyAvailabilityBody = z.infer<
  typeof setWeeklyAvailabilitySchema
>;
export type SetBreaksBody = z.infer<typeof setBreaksSchema>;
export type CreateOverrideBody = z.infer<typeof createOverrideSchema>;
export type UpdateOverrideBody = z.infer<typeof updateOverrideSchema>;
export type CreateTimeOffBody = z.infer<typeof createTimeOffSchema>;
export type UpdateTimeOffBody = z.infer<typeof updateTimeOffSchema>;
