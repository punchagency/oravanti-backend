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
  windows: z.array(windowSchema),
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
  breaks: z.array(breakSchema),
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

export type SetWeeklyAvailabilityBody = z.infer<
  typeof setWeeklyAvailabilitySchema
>;
export type SetBreaksBody = z.infer<typeof setBreaksSchema>;
export type CreateOverrideBody = z.infer<typeof createOverrideSchema>;
