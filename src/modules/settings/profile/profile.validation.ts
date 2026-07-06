import { z } from "zod";
import { isValidTimezone } from "../../../utils/date";

/**
 * Profile update body. Kept lax (passthrough) to match the previous
 * `optionalBody()` behavior, but validates `timezone` as a real IANA
 * identifier when present since it now maps to a persisted column.
 */
export const updateProfileSchema = z
  .object({
    timezone: z
      .string()
      .refine(isValidTimezone, { message: "Invalid IANA timezone" })
      .optional(),
  })
  .passthrough();
